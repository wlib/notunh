// Downloads the Wildcat Transit GTFS feed (the same one Google Maps uses) and converts it into the compact JSON the
// app bundles, keeping the zip beside it for a learning build to acquire with it (replay.mts). The feed host doesn't
// send CORS headers, so this has to happen at build time, and the site rebuilds nightly to pick up a new feed. With
// --if-missing, a schedule already there with its zip is kept

import { writeFile } from "node:fs/promises"
import { unzipSync, strFromU8 } from "fflate"
import { convert, parseTable } from "./convert.mts"
import { ORIGINAL } from "./replay.mts"
import { exists, isKept } from "../files.mts"

const FEED_URL = "https://rapid.nationalrtap.org/GTFSFileManagement/UserUploadFiles/11637/google_transit.zip"
const OUTPUT = new URL("../../src/map/gtfs.json", import.meta.url)

if (await isKept(OUTPUT) && await exists(ORIGINAL))
  process.exit(0)

const response = await fetch(FEED_URL)
if (!response.ok)
  throw new Error(`Failed to download GTFS: ${response.status}`)

const zip = new Uint8Array(await response.arrayBuffer())
const files = unzipSync(zip)
const feed = convert(name =>
  files[name]
    ? parseTable(strFromU8(files[name]))
    : []
)

// A feed missing its tables would deploy a map with no buses, so failing keeps the last one up
if (!feed.trips.length || !feed.stops.length)
  throw new Error("GTFS feed has no trips or stops")

await Promise.all([writeFile(OUTPUT, JSON.stringify(feed)), writeFile(ORIGINAL, zip)])
console.log(`Wrote ${feed.routes.length} routes, ${feed.stops.length} stops, ${feed.trips.length} trips (feed ${feed.version}, ${feed.start}–${feed.end})`)
