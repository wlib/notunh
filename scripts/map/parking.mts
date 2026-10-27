// The parking areas a page loads, src/parking/parking.json: the hand-kept areas (src/parking/areas.mts) checked
// against the three sources a machine can read (src/parking/sources.mts), so a stale row fails the night rather than
// misleading a driver. Made nightly with the inputs (scripts/data.mts), from:
// - UNH's pay-per-hour zone table, the PDF the visitor page links, one request for each;
// - ParkMobile's zones around campus, one request, with no User-Agent of ours;
// - OpenStreetMap's parking areas, as the map data installed has them (src/map/parking.json, made each week by
//   scripts/map/osm.mts), or for map data made before it had them, read from the New Hampshire extract in extract/,
//   downloaded from Geofabrik if it isn't there.
//
//   node scripts/map/parking.mts [--extract <file.osm.pbf>]   fetches, checks, and writes the inputs' copy
//   node scripts/map/parking.mts --cached                     checks the copies in tests/fixtures/parking/ instead
//   node scripts/map/parking.mts --refresh                    fetches, and saves what it fetched as those copies
//
// Offline (NOTUNH_OFFLINE), it reads the copies, as the fixtures are made (tests/fixtures/make.mts). Any problem
// fails it, listing every one

import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as v from "valibot"
import { AREAS } from "../../src/parking/areas.mts"
import { type ParkingData, OSM_PARKING, OsmParkingList, PARKING, PARKMOBILE, ParkMobileList, VISITOR_PAGE, checked, pdfLines, zoneTable, zoneTableUrl } from "../../src/parking/sources.mts"
import { REPO, download, exists, isOffline, writeInput } from "../files.mts"
import { parkingJson, parkingWithin } from "./osm.mts"

const CACHED = new URL("tests/fixtures/parking/", REPO)

const EXTRACT = "extract/new-hampshire.osm.pbf"

/** The three sources, each as its raw bytes or text, to check and, refreshing, to keep */
type Sources = { pdf: Uint8Array<ArrayBuffer>, zonesAt: number, parkMobile: string, osm: OsmParkingList }

/** A fetch's body, or a failure naming the URL */
const body = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok)
    throw new Error(`${response.status} from ${url}`)
  return response
}

/** OpenStreetMap's parking areas: the map data's, else the extract's */
const osmParking = async (args: string[]) => {
  if (await exists(new URL(OSM_PARKING, REPO)) && !args.includes("--extract"))
    return v.parse(OsmParkingList, JSON.parse(await readFile(new URL(OSM_PARKING, REPO), "utf8")))
  const extract = args.includes("--extract") ? args[args.indexOf("--extract") + 1] : EXTRACT
  if (!(await exists(new URL(extract, REPO)))) {
    await mkdir(new URL("extract/", REPO), { recursive: true })
    await download("https://download.geofabrik.de/north-america/us/new-hampshire-latest.osm.pbf", new URL(extract, REPO).pathname)
  }
  return parkingWithin(new URL(extract, REPO).pathname)
}

/** The three sources as fetched now */
const fetched = async (args: string[]): Promise<Sources> => {
  const pdfUrl = zoneTableUrl(await (await body(VISITOR_PAGE)).text())
  if (!pdfUrl)
    throw new Error(`The visitor page (${VISITOR_PAGE}) no longer links parking-meter-info.pdf`)
  const pdf = new Uint8Array(await (await body(pdfUrl)).arrayBuffer())
  const zonesAt = Date.now()
  const parkMobile = await (await body(PARKMOBILE)).text()
  return { pdf, zonesAt, parkMobile, osm: await osmParking(args) }
}

/** The copies kept in the fixtures, as fetched last by --refresh */
export const cached = async (): Promise<Sources> => ({
  pdf:        new Uint8Array(await readFile(new URL("zones.pdf", CACHED))),
  zonesAt:    v.parse(v.object({ zones: v.number() }), JSON.parse(await readFile(new URL("fetched.json", CACHED), "utf8"))).zones,
  parkMobile: await readFile(new URL("parkmobile.json", CACHED), "utf8"),
  osm:        v.parse(OsmParkingList, JSON.parse(await readFile(new URL("osm.json", CACHED), "utf8")))
})

/** The areas checked against the sources, as the file a page loads, or every problem found, thrown */
export const parkingOf = async (sources: Sources, built: number) => {
  const parkMobile = v.parse(ParkMobileList, JSON.parse(sources.parkMobile))
  const { areas, problems, notes } = checked(AREAS, { table: zoneTable(await pdfLines(sources.pdf)), parkMobile: parkMobile.zones, osm: sources.osm.elements })
  if (problems.length)
    throw new Error(`Parking areas disagree with their sources:\n${problems.join("\n")}`)
  const data: ParkingData = { sources: { zones: sources.zonesAt, parkMobile: parkMobile.at, osm: Date.parse(sources.osm.timestamp) }, built, areas }
  return { data, notes, json: `{"sources":${JSON.stringify(data.sources)},"built":${data.built},"areas":[\n${areas.map(area => JSON.stringify(area)).join(",\n")}\n]}\n` }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const sources = isOffline || args.includes("--cached") ? await cached() : await fetched(args)

  if (args.includes("--refresh")) {
    await writeFile(new URL("zones.pdf", CACHED), sources.pdf)
    await writeFile(new URL("fetched.json", CACHED), JSON.stringify({ zones: sources.zonesAt }) + "\n")
    await writeFile(new URL("parkmobile.json", CACHED), sources.parkMobile)
    await writeFile(new URL("osm.json", CACHED), parkingJson(sources.osm))
  }

  const { data: { areas }, notes, json } = await parkingOf(sources, Date.now())
  for (const note of notes)
    console.log(note)
  await writeInput(PARKING, json)
  console.log(`${areas.length} parking areas, ${areas.filter(area => area.osm.length).length} outlined in OpenStreetMap, ${areas.filter(area => area.zone).length} zones, ${areas.filter(area => area.guessed).length} guessed`)
}
