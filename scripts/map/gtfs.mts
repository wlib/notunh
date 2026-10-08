// Downloads the Wildcat Transit GTFS feed (the same one Google Maps uses)
// and converts it into the compact JSON the app bundles.
// The feed host doesn't send CORS headers, so this has to happen at build time;
// CI rebuilds nightly to pick up a new feed. With --if-missing, a schedule already there is kept

import { writeFile } from "node:fs/promises"
import { unzipSync, strFromU8 } from "fflate"
import { convert, parseTable } from "./convert.mts"
import { isKept } from "../files.mts"

const FEED_URL = "https://rapid.nationalrtap.org/GTFSFileManagement/UserUploadFiles/11637/google_transit.zip"
const OUTPUT = new URL("../../src/map/gtfs.json", import.meta.url)

if (await isKept(OUTPUT))
  process.exit(0)

const response = await fetch(FEED_URL)
if (!response.ok)
  throw new Error(`Failed to download GTFS: ${response.status}`)

const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
const feed = convert(name =>
  files[name]
    ? parseTable(strFromU8(files[name]))
    : []
)

// A feed missing its tables would deploy a map with no buses, so failing keeps the last one up
if (!feed.trips.length || !feed.stops.length)
  throw new Error("GTFS feed has no trips or stops")

await writeFile(OUTPUT, JSON.stringify(feed))
console.log(`Wrote ${feed.routes.length} routes, ${feed.stops.length} stops, ${feed.trips.length} trips (feed ${feed.version}, ${feed.start}–${feed.end})`)
