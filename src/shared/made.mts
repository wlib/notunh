// Where the map's OpenStreetMap data came from, which every file of a map data generation carries. The walk graph,
// the gazetteer, and the tiles' folder are made together from one extract by one version of the code
// (scripts/map/osm.mts), and published together. A page may briefly run one generation's walk beside another's
// gazetteer, since each data file loads on its own. That's fine, as they meet only by coordinates

import * as v from "valibot"
import { Day } from "./time.mts"

export const Made = v.object({
  /** The day of the extract they were made from */
  extract:   Day,
  /** A hash of everything that made them: the generating code, the campus tile profile, and Planetiler's version */
  generator: v.string()
})
export type Made = v.InferOutput<typeof Made>

/** How much of the generator's hash names a version */
const SHORT = 8

/** What a generation is called, in the tiles' folder and the release's tag: its extract, and enough of its generator */
export const versionOf = ({ extract, generator }: Made) =>
  `${extract}-${generator.slice(0, SHORT)}`
