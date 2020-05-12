import fetch from "node-fetch";
import yauzl, { Entry, ZipFile } from "yauzl";
import { Opaque, Writable } from "ts-essentials";
import { JSDOM } from "jsdom";
import * as d3 from "d3";
import fs from "fs";
import { convert, PNG } from "convert-svg-to-png";
import { getTwitterClient } from "./twitter";

/**
 * Set the d3 locale to de-De for parsing and formatting
 */
const setLocale = async () => {
  const locale = await (
    await fetch(
      "https://cdn.jsdelivr.net/npm/d3-time-format@2/locale/de-DE.json",
    )
  ).json();
  d3.timeFormatDefaultLocale(locale);
};

const CSVURL = "https://info.gesundheitsministerium.at/data/data.zip";

/**
 * Simple opaque type for CSVs 2 dimensional string array
 */
type CSV = Opaque<"CSV", string[][]>;

/**
 * Convert a zipfile entry to a CSV
 *
 * @param zipfile the opened zipfile
 * @param entry an entry of the zipfile
 * @returns the data as CSV
 * @see CSV
 */
const toCSV = async (zipfile: ZipFile, entry: Entry): Promise<CSV> => {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err != null) {
        return reject(err);
      }
      if (readStream == null) {
        return reject(new Error("NullError"));
      }
      const csvData: string[][] = [];
      readStream.on("data", (buffer: Buffer) => {
        const csvString = buffer.toString("utf8");
        csvData.push(
          ...csvString
            .trim()
            .split("\n")
            .map((row) =>
              row
                .trim()
                .split(";")
                .map((cell) =>
                  // first row sometimes "<5" or similar
                  cell.trim(),
                ),
            ),
        );
      });
      readStream.on("end", () => {
        resolve(csvData as CSV);
      });
      readStream.on("error", (error) => {
        reject(error);
      });
    });
  });
};

type Timeline = [Date, number][];

interface Data {
  readonly cases: Timeline;
  readonly recovered: Timeline;
  readonly deaths: Timeline;
}

/**
 * Parse a number and return 0 should it be invalid.
 *
 * @param value a number or a string to parse
 * @returns the number or 0 if invalid
 */
const orZero = (value: number | string): number | 0 => {
  if (typeof value === "string") {
    value = Number(value);
  }
  return Number.isNaN(value) ? 0 : value;
};

/**
 * Download zip file from URL and parse it into CSV data.
 *
 * @returns the data as CSV
 */
const fetchData = async (): Promise<Data> => {
  const csvzip = await fetch(CSVURL);
  const csvbuffer = await csvzip.buffer();
  const parseTime = d3.timeParse("%d.%m.%Y");
  return new Promise((resolve, reject) => {
    const result: Promise<[keyof Data, Timeline]>[] = [];
    yauzl.fromBuffer(csvbuffer, { autoClose: false }, (err, zipfile) => {
      if (err) {
        return reject(err);
      }
      if (zipfile == null) {
        return reject(new Error("NullError"));
      }
      zipfile.on("error", reject);
      zipfile.on("entry", (entry) => {
        if (entry.fileName.indexOf("Epikurve") >= 0) {
          result.push(
            toCSV(zipfile, entry).then((csv) => {
              return [
                "cases",
                csv.slice(1).reduce(
                  ([timeline, sum], [date, value]): [Timeline, number] => {
                    sum += orZero(value);
                    timeline.push([parseTime(date) ?? new Date(0), sum]);
                    return [timeline, sum];
                  },
                  [[], 0] as [Timeline, number],
                )[0],
              ];
            }),
          );
        } else {
          const key =
            entry.fileName.indexOf("GenesenTimeline") >= 0
              ? "recovered"
              : entry.fileName.indexOf("TodesfaelleTimeline") >= 0
              ? "deaths"
              : null;
          if (key != null) {
            result.push(
              toCSV(zipfile, entry).then((csv) => {
                return [
                  key,
                  csv
                    .slice(1)
                    .map(([date, value]): [Date, number] => [
                      parseTime(date) ?? new Date(0),
                      orZero(value),
                    ]),
                ];
              }),
            );
          }
        }
      });
      zipfile.on("end", async () => {
        if (result.length === 3) {
          const csvs = await Promise.all<[keyof Data, Timeline]>(result);
          const firstDate = Math.max(
            ...csvs.map(([, timeline]) => timeline[0][0].getTime()),
          );
          const lastDate: Date = csvs.reduce(
            (date, [, timeline]) =>
              timeline[timeline.length - 1][0] < date
                ? timeline[timeline.length - 1][0]
                : date,
            new Date(), //works for this case
          );
          resolve(
            csvs.reduce((acc, [key, timeline]) => {
              // some have different lengths, get common time frame
              const firstIndex = timeline.findIndex(
                ([date]) => date.getTime() >= firstDate,
              );
              const reverseLastIndex = timeline
                .slice(0)
                .reverse()
                .findIndex(([date]) => date <= lastDate);
              const lastIndex = timeline.length - 1 - reverseLastIndex;
              acc[key] = timeline.slice(firstIndex, lastIndex + 1);
              return acc;
            }, {} as Writable<Data>) as Data,
          );
        } else {
          reject(result);
        }
        zipfile.close();
      });
    });
  });
};

//https://github.com/d3/d3-scale/issues/90#issuecomment-451762692
/**
 * A d3 scaler for radial scaling.
 *
 * @param innerRadius inner radius of radial scaling
 * @param outerRadius outer radius of radial scaling
 * @returns a d3 scaler for radial scaling
 */
const scaleRadial = (
  innerRadius: number,
  outerRadius: number,
): d3.ScaleContinuousNumeric<number, number> => {
  // This scale maintains area proportionality of radial bars!
  const y = d3
    .scaleLinear<number, number>()
    // .domain([0, d3.max(data, d => d.total)])
    .range([innerRadius * innerRadius, outerRadius * outerRadius]);
  return Object.assign(
    (d: number | { valueOf(): number }) => Math.sqrt(y(d)),
    y,
  );
};

/**
 * Generate a circular svg path
 *
 * @param r radius of the circle
 * @param cx (optional) center x position of circle. (default: 0)
 * @param cy (optional) center y position of circle. (default: 0)
 * @returns a svg path describing a circle
 */
const circlePath = (r: number, cx: number = 0, cy: number = 0) =>
  `M ${cx} ${cy} m -${r}, 0 a ${r},${r} 0 1,1 ${r * 2},0 a ${r},${r} 0 1,1 -${
    r * 2
  },0`;

/**
 * Draw the the radial bar chart as a d3 svg in jsdom and returns a rendered binary PNG.
 *
 * @param data total cases, recovered, deaths accumulative
 */
const draw = async ({ cases, recovered, deaths }: Data): Promise<PNG> => {
  if (cases.length !== recovered.length || cases.length !== deaths.length) {
    console.log(cases, recovered, deaths);
    throw Error("lengths unequal");
  }
  const jsdom = new JSDOM("<html lang='en'><body><svg></svg></body></html>");
  const document = jsdom.window.document;

  const margin = { top: 120, right: 120, bottom: 120, left: 120 };
  const width = 1980 - margin.left - margin.right,
    height = 1980 - margin.top - margin.bottom;

  const svg = d3
    .select(document)
    .select("svg")
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .style("background", "rgb(21, 32, 43)")
    .append("g")
    .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

  const g = svg
    .append("g")
    .attr("transform", "translate(" + width / 2 + "," + height / 2 + ")");

  const innerRadius = 350,
    outerRadius = Math.min(width, height) / 2 - 6;

  const formatDate = d3.timeFormat("%d.%m");

  const fullCircle = 2 * Math.PI;

  const x = d3.scaleTime().range([0, fullCircle]);
  const y = scaleRadial(innerRadius, outerRadius);

  const dateExtent = d3.extent<[Date, number], Date>(cases, ([date]) => date);
  if (dateExtent[0] == null) {
    throw new Error("date error");
  }
  x.domain(dateExtent);

  const valueExtent = d3.extent(cases, ([, value]) => value);
  if (valueExtent[0] == null) {
    throw new Error("value error");
  }
  y.domain([0, valueExtent[1]]);

  const numBars = cases.length;

  const active = cases.map(([date, cases], idx): [Date, number] => [
    date,
    cases - recovered[idx][1] - deaths[idx][1],
  ]);
  const timelines: [Timeline, string][] = [
    [active, "rgb(255, 173, 31)"],
    [recovered, "rgb(29, 161, 242)"],
    [deaths, "rgb(121, 75, 196)"],
  ];
  timelines.forEach(([timeline, color], idx) => {
    const offset = timelines
      .slice(0, idx)
      .reduce((sum: number[], [timeline]) => {
        timeline.forEach(([, value], idx) => (sum[idx] += value));
        return sum;
      }, Array(numBars).fill(0));
    const arc = d3
      .arc<any, [Date, number]>()
      .padAngle((Math.PI / numBars) * 0.075)
      .innerRadius((d, idx) => y(offset[idx]))
      .outerRadius(([, value], idx) => y(value + offset[idx]))
      .startAngle((d, i) => (i * 2 * Math.PI) / numBars)
      .endAngle((d, i) => ((i + 1) * 2 * Math.PI) / numBars);
    g.selectAll(".arc" + idx)
      .data(timeline)
      .enter()
      .append("path")
      .style("fill", color)
      .attr("class", "arc" + idx)
      .attr("d", arc);
  });

  const yAxis = g.append("g").attr("text-anchor", "middle");
  const yTick = yAxis
    .selectAll("g")
    .data(y.ticks(5).concat([active[active.length - 1][1]]))
    .enter()
    .append("g");

  yTick
    .append("circle")
    .attr("fill", "none")
    .attr("stroke", "white")
    .attr("opacity", 1)
    .attr("r", y);

  yTick
    .append("text")
    .attr("y", (d) => -y(d))
    .attr("dy", "-0.25em")
    .attr("dx", "5")
    .attr("fill", "white")
    .attr("stroke", "none")
    .attr("text-anchor", "start")
    .style("font-size", "36px")
    .style("font-family", "sans-serif")
    .text((d) => (d === 0 ? "" : Math.round(d / 1000) + "k"));

  const scaleFont = d3.scaleLinear().range([10, 26]).domain(y.domain());
  const scaleFontDy = d3.scaleLinear().range([6, 12]).domain(y.domain());
  g.append("g")
    .attr("class", "dates")
    .selectAll("dateTicks")
    .data(cases)
    .enter()
    .append("text")
    .attr("class", "dataTicks")
    .attr("text-anchor", ([, cases]) =>
      scaleFont(cases) > 18 ? "middle" : "start",
    )
    .attr("fill", "white")
    .attr("stroke", "none")
    .style("font-size", ([, cases]) => Math.max(18, scaleFont(cases)) + "px")
    .style("font-family", "sans-serif")
    .text(([date]) => formatDate(date))
    //.attr("y", ([, cases]) => -y(cases))
    .attr("dx", ([, cases]) => (scaleFont(cases) <= 18 ? 8 : 0))
    .attr(
      "dy",
      ([, cases]) => (scaleFont(cases) > 18 ? -scaleFontDy(cases) : 6) + "px",
    )
    .attr(
      "transform",
      ([, cases], i) =>
        `rotate(${(i + 0.5) * (360 / numBars)}) translate(0, ${-y(
          cases,
        )}) rotate(${scaleFont(cases) > 18 ? 0 : "-90"})`,
    );

  const legend = g.append("g").attr("class", "legend");
  const square = 32;
  const squareXPad = 0.667 * square;
  const textX = -147;
  const fontSize = square * 1.75;
  const textYPad = 0.334 * fontSize;
  const legends = timelines.map(([, color], idx) => [
    idx === 0 ? "Active Cases" : idx === 1 ? "Total Recovered" : "Total Deaths",
    color,
  ]);
  const opticalYPad = 70;
  const textY = -opticalYPad;
  legend.attr("transform", `translate(0, -${(textYPad + fontSize) / 2})`);
  legend
    .selectAll(".legendSquare")
    .data(legends)
    .enter()
    .append("rect")
    .attr("class", "legendSquare")
    .attr("x", textX - square - squareXPad)
    .attr("y", (_, i) => textY + i * (fontSize + textYPad) - square)
    .attr("width", square)
    .attr("height", square)
    .attr("fill", ([, color]) => color);
  legend
    .selectAll(".legendText")
    .data(legends)
    .enter()
    .append("text")
    .attr("class", "legendText")
    .attr("text-anchor", "start")
    .style("font-size", `${fontSize}px`)
    .style("font-family", "sans-serif")
    .attr("x", textX)
    .attr("y", (_, i) => textY + i * (fontSize + textYPad))
    .attr("fill", "white")
    .attr("stroke", "none")
    .text(([legend]) => legend);

  g.append("text")
    .attr("x", 0)
    .attr("y", legends.length * (fontSize + textYPad))
    .attr("dy", -30)
    .attr("fill", "white")
    .attr("text-anchor", "middle")
    .style("font-size", "45px")
    .style("font-family", "sans-serif")
    .style("font-style", "italic")
    .style("font-weight", "bold")
    .text("@chjdev");

  g.append("path")
    .attr("id", "circlePath") //Unique id of the path
    .attr("d", circlePath(outerRadius + scaleFontDy.range()[1])) //SVG path
    .style("fill", "none")
    .style("stroke", "none");

  g.append("text")
    .append("textPath")
    .attr("xlink:href", "#circlePath")
    .style("text-anchor", "middle")
    .attr("startOffset", "39%")
    .attr("fill", "white")
    .style("font-size", "32px")
    .style("font-family", "sans-serif")
    .text(
      "https://github.com/chjdev/cotwit19\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0https://info.gesundheitsministerium.at/data/data.zip",
    );

  return await convert(d3.select(document).select("body").html());
};

/**
 * Tweet the PNG
 *
 * @param media the png to tweet
 * @returns the new tweet's id
 */
const tweet = async (media: PNG): Promise<string> => {
  const mediaUploadResponse = await getTwitterClient("upload").post(
    "media/upload",
    {
      /* eslint-disable @typescript-eslint/camelcase */
      media_data: Buffer.from(media).toString("base64"),
      /* eslint-enable @typescript-eslint/camelcase */
    },
  );
  const tweetResponse = await getTwitterClient("api").post("statuses/update", {
    status:
      d3.timeFormat("%d.%m.%Y")(new Date()) +
      " #COVID19 situation in #Austria. https://github.com/chjdev/cotwit19",
    /* eslint-disable @typescript-eslint/camelcase */
    media_ids: mediaUploadResponse.media_id_string,
    /* eslint-enable @typescript-eslint/camelcase */
  });
  return tweetResponse.id;
};

/**
 * Fetch data, render a png, tweet it and write it to disk
 */
const main = async () => {
  await setLocale();
  const data = await fetchData();
  const png = await draw(data);
  const tweetId = await tweet(png);
  fs.writeFileSync(tweetId + ".png", png);
};

main();
