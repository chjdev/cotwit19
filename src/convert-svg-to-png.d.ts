declare module "convert-svg-to-png" {
  import { Opaque } from "ts-essentials";
  export type PNG = Opaque<"PNG", number[]>;
  export const convert: (svg: string) => Promise<PNG>;
}
