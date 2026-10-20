// Downloads the Wildcat Transit GTFS feed (the same one Google Maps uses) and converts it into the compact JSON the
// app bundles, keeping the zip beside it for learning to acquire with it (replay.mts). The feed host doesn't send
// CORS headers, so this happens as the inputs are made each night (scripts/data.mts), which picks up a new feed

import { unzipSync, strFromU8 } from "fflate"
import { convert, parseTable } from "./convert.mts"
import { FEED, ORIGINAL } from "./replay.mts"
import { writeInput } from "../files.mts"

const FEED_URL = "https://rapid.nationalrtap.org/GTFSFileManagement/UserUploadFiles/11637/google_transit.zip"

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

await Promise.all([writeInput(FEED, JSON.stringify(feed)), writeInput(ORIGINAL, zip)])
console.log(`Wrote ${feed.routes.length} routes, ${feed.stops.length} stops, ${feed.trips.length} trips (feed ${feed.version}, ${feed.start}–${feed.end})`)
