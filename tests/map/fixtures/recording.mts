// Half an hour of the Worker's samples, recorded on a Wednesday afternoon, 2026-10-07, with seven buses out, and the
// timetable then, cut down to their routes: route 3 from Kingsbury Hall out to Durham Road at Mast Road, 5 km off,
// and route Gables from the Gables apartments round campus by Kingsbury Hall. A route 3 bus is on its way to Thompson
// Hall (stop 209), due there at 18:31 UTC and leaving at 18:40. Read once here for every test that replays it

import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { type FeedData, withIndexes } from "../../../src/transit/feed.mts"
import { type RawFix, type RawPrediction, unpackFixes, unpackPredictions } from "../../../src/transit/observations/raw.mts"

/** A sample as the crons stored it then, before rows were versioned: a bare array of samples */
export type RecordedRow = { source: string, at: number, body: unknown[] }

// By its path, as the Worker's tests read it too, whose URL isn't Node's
export const { feed: recordedData, rows: recordedRows }: { feed: FeedData, rows: RecordedRow[] } =
  JSON.parse(gunzipSync(readFileSync(decodeURIComponent(new URL("buses.json.gz", import.meta.url).pathname))).toString())

export const recordedFeed = withIndexes(recordedData)

/** The buses' fixes, in the order of their samples */
export const recordedFixes = recordedRows.filter(row => row.source === "buses")
  .flatMap(row => unpackFixes(row.at, { version: 0, samples: row.body as RawFix[], polls: null }))

/** Umo's predictions, by the sample they came in */
export const recordedPredictions = recordedRows.filter(row => row.source === "predictions")
  .map(row => ({ at: row.at, predictions: unpackPredictions(row.at, { version: 0, samples: row.body as RawPrediction[], polls: null }) }))
