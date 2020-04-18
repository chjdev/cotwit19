import fetch from "node-fetch";
import yauzl, { Entry, ZipFile } from "yauzl";
import { Buildable, DeepReadonly, Opaque, Writable } from "ts-essentials";
import { JSDOM } from "jsdom";
import * as d3 from "d3";
import fs from "fs";
import { convert, PNG } from "convert-svg-to-png";

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
        resolve((csvData as any) as CSV);
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
      const parseTime = d3.timeParse("%d.%m.%Y");
      zipfile.on("entry", (entry) => {
        if (entry.fileName.indexOf("Epikurve") >= 0) {
          result.push(
            toCSV(zipfile, entry).then((csv) => {
              return [
                "cases",
                csv
                  .slice(1)
                  .map(([date, value], idx, arr): [Date, number] => [
                    parseTime(date) ?? new Date(0),
                    arr
                      .slice(0, idx + 1)
                      .reduce((sum, [, value]) => sum + orZero(value), 0),
                  ]),
              ];
            }),
          );
        } else if (entry.fileName.indexOf("GenesenTimeline") >= 0) {
          result.push(
            toCSV(zipfile, entry).then((csv) => {
              return [
                "recovered",
                csv
                  .slice(1)
                  .map(([date, value]): [Date, number] => [
                    parseTime(date) ?? new Date(0),
                    orZero(value),
                  ]),
              ];
            }),
          );
        } else if (entry.fileName.indexOf("TodesfaelleTimeline") >= 0) {
          result.push(
            toCSV(zipfile, entry).then((csv) => {
              return [
                "deaths",
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
      });
      zipfile.on("end", async () => {
        if (result.length === 3) {
          const csvs = await Promise.all<[keyof Data, Timeline]>(result);
          const firstDate = Math.max(
            ...csvs.map(([, timeline]) => timeline[0][0].getTime()),
          );
          const lastDate = Math.min(
            ...csvs.map((timeline) =>
              timeline[1][timeline[1].length - 1][0].getTime(),
            ),
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
                .findIndex(([date]) => date.getTime() < lastDate);
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
 * Draw the the radial bar chart as a d3 svg in jsdom and returns a rendered binary PNG.
 *
 * @param cases total cases accumulative
 * @param recovered total recovered accumulative
 * @param deaths total deaths accumulative
 */
const draw = async ({ cases, recovered, deaths }: Data): Promise<PNG> => {
  if (cases.length !== recovered.length || cases.length !== deaths.length) {
    console.log(cases, recovered, deaths);
    throw Error("lengths unequal");
  }
  const jsdom = new JSDOM("<html><body><svg></svg></body></html>");
  const document = jsdom.window.document;

  const margin = { top: 50, right: 50, bottom: 30, left: 50 };
  const width = 3960 - margin.left - margin.right,
    height = 1980 - margin.top - margin.bottom;

  const svg = d3
    .select(document)
    .select("svg")
    .attr("xmlns", "http://www.w3.org/2000/svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .style("background", "rgb(21, 32, 43)")
    // .style("border-radius", "80px")
    .append("g")
    .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

  const g = svg
    .append("g")
    .attr("transform", "translate(" + width / 2 + "," + height / 2 + ")");

  const innerRadius = 350,
    outerRadius = Math.min(width, height) / 2 - 6;

  const formatDate = d3.timeFormat("%b %d");

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
  const arcs = timelines.map(([timeline, color], idx) => {
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
    return g
      .selectAll(".arc" + idx)
      .data(timeline)
      .enter()
      .append("path")
      .style("fill", color)
      .attr("class", "arc" + idx)
      .attr("d", arc);
  });

  const yAxis = g.append("g").attr("text-anchor", "middle");
  const yTick = yAxis.selectAll("g").data(y.ticks(5)).enter().append("g");

  yTick
    .append("circle")
    .attr("fill", "none")
    .attr("stroke", "white")
    .attr("opacity", 1)
    .attr("r", y);

  yAxis
    .append("circle")
    .attr("fill", "none")
    .attr("stroke", "black")
    .attr("opacity", 0.2)
    .attr("r", () => y(y.domain()[0]));

  const labels = yTick
    .append("text")
    .attr("y", (d) => -y(d))
    .attr("dy", "-0.1em")
    .attr("fill", "white")
    .attr("stroke", "none")
    .attr("transform", "translate(6)")
    .attr("text-anchor", "start")
    .style("font-size", "36px")
    .style("font-family", "sans-serif")
    .text((d) => d.toString());

  const tag = g
    .append("text")
    .attr("x", width * 0.125)
    .attr("y", height / 2)
    .attr("dy", -30)
    .attr("fill", "white")
    .attr("opacity", 0.75)
    .style("font-size", "48px")
    .style("font-family", "sans-serif")
    .style("font-style", "italic")
    .style("font-weight", "bold")
    .text("@chjdev");

  // const xAxis = g.append("g");
  //
  // const numXTicks = numBars / 2;
  // const xTick = xAxis
  //   .selectAll("g")
  //   .data(x.ticks(numXTicks))
  //   .enter()
  //   .append("g")
  //   .attr("text-anchor", "middle")
  //   .attr(
  //     "transform",
  //     (d, i) =>
  //       "rotate(" +
  //       // ((x(d) * 180) / Math.PI - 90) +
  //       ((180 * (((i + 0.5) / numXTicks) * 2 * Math.PI)) / Math.PI - 90) +
  //       ")translate(" +
  //       innerRadius +
  //       ",0)",
  //   );
  //
  // xTick.append("line").attr("x2", -5).attr("stroke", "#000");
  //
  // xTick
  //   .append("text")
  //   .attr("transform", (d, i) => {
  //     const angle = ((i + 0.5) / numXTicks) * 2 * Math.PI;
  //     return angle < Math.PI / 2 || angle > (Math.PI * 3) / 2
  //       ? "rotate(90)translate(0,22)"
  //       : "rotate(-90)translate(0, -15)";
  //   })
  //   .text((d) => formatDate(d))
  //   .style("font-size", 10)
  //   .attr("opacity", 0.6);

  return await convert(d3.select(document).select("body").html());
};

/**
 * Fetch data, render a png and write it to disk
 * @todo automatically post to twitter
 */
const main = async () => {
  const data = await fetchData();
  const png = await draw(data);
  fs.writeFileSync("test.png", png);
};

main();
