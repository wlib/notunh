// OpenStreetMap, from one extract of New Hampshire: the streets and paths people walk around Durham, as the network
// at src/map/walk.json; the places people go, as the gazetteer at src/map/gazetteer.json; and, with Planetiler, our
// own map tiles (scripts/map/tiles.mts). All three are marked with where they came from (src/shared/made.mts). Each
// week the Map data workflow makes them from Geofabrik's latest extract and publishes them as a generation of the
// map-data release (scripts/release.mts):
//
//   node scripts/map/osm.mts [<extract.osm.pbf> [<planetiler.jar>]] [--release <folder>]
//
// Without an extract, it downloads Geofabrik's latest into extract/. Without Planetiler, it uses the one in
// planetiler/, downloading the version PLANETILER names if there isn't one, or with neither, makes no tiles.
// Given a folder, it stages the generation there to publish, unless the pointer already names this very one. A build
// installs the generation it pins (scripts/inputs.mts)

import { createReadStream } from "node:fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { elementsWithin } from "./pbf.mts"
import type { Box } from "../../src/geo/boxes.mts"
import { HIGHWAYS, walkGraph } from "./walkable.mts"
import { gazetteerOf } from "./gazetteer.mts"
import { PLACE_KEYS } from "../../src/places/gazetteer.mts"
import { type Made, versionOf } from "../../src/shared/made.mts"
import { TILES, makeTiles } from "./tiles.mts"
import { generator } from "./generator.mts"
import { fetchPointer, hashesUnder, stage, stagePointer } from "../release.mts"
import { download, exists } from "../files.mts"

const WALK      = new URL("../../src/map/walk.json", import.meta.url)
const GAZETTEER = new URL("../../src/map/gazetteer.json", import.meta.url)

// Durham, from Lee to the bay, and from Madbury to Packers Falls, as [west, south, east, north]
const DURHAM: Box = [-70.99, 43.08, -70.88, 43.17]

const WALKABLE = new Set(HIGHWAYS)

// The paths the network is made of, the places the gazetteer is, and the doors of its buildings
const isWanted = (tags: Record<string, string>) =>
  WALKABLE.has(tags.highway) ||
  !!tags.name && PLACE_KEYS.some(key => tags[key]) ||
  !!tags.entrance

/** The walk and gazetteer from an extract, and where they're from, which names the tiles' version */
const fromExtract = async (extract: string): Promise<Made> => {
  const { elements, timestamp } = await elementsWithin(() => createReadStream(extract), DURHAM, isWanted)
  const graph = walkGraph(elements)
  if (graph.vertices.length < 2000)
    throw new Error(`Only ${graph.vertices.length / 2} vertices in the walking network`)
  const places = gazetteerOf(elements)
  const buildings = places.filter(place => place.kind === "building").length
  if (buildings < 100)
    throw new Error(`Only ${buildings} buildings in the gazetteer`)

  const made: Made = { extract: (timestamp ?? new Date()).toISOString().slice(0, 10), generator: await generator() }
  await writeFile(WALK, JSON.stringify({ made, ...graph }) + "\n")
  await writeFile(GAZETTEER, `{"made":${JSON.stringify(made)},"places":[\n${places.map(place => JSON.stringify(place)).join(",\n")}\n]}\n`)
  console.log(`${graph.vertices.length / 2} vertices in the walking network, and ${places.length} places in the gazetteer, from the extract of ${made.extract}`)
  return made
}

/** Stages a generation to publish, from the walk, gazetteer, and tiles just made */
const stageMade = async (made: Made, folder: string) => {
  const version = versionOf(made)
  const files = await mkdtemp(join(tmpdir(), "notunh-map-data-"))
  await cp(WALK, join(files, "walk.json"))
  await cp(GAZETTEER, join(files, "gazetteer.json"))
  await cp(fileURLToPath(new URL(`${version}/`, TILES)), join(files, "tiles"), { recursive: true })
  await stage("map-data", { ...made, version, files: await hashesUnder(files) }, files, folder)
  await rm(files, { recursive: true })
}

const args = process.argv.slice(2)
const release = args.includes("--release") ? args[args.indexOf("--release") + 1] : undefined
const [given, givenJar] = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--release")
const extract = given ?? "extract/new-hampshire.osm.pbf"
if (!given) {
  await mkdir("extract", { recursive: true })
  await download("https://download.geofabrik.de/north-america/us/new-hampshire-latest.osm.pbf", extract)
}
const jar = givenJar ?? (process.env.PLANETILER ? "planetiler/planetiler.jar" : undefined)
if (jar && !givenJar && !await exists(pathToFileURL(resolve(jar)))) {
  await mkdir("planetiler", { recursive: true })
  await download(`https://github.com/onthegomap/planetiler/releases/download/v${process.env.PLANETILER}/planetiler.jar`, jar)
}
const made = await fromExtract(extract)
const version = versionOf(made)
if ((await fetchPointer("map-data"))?.version === version) {
  if (release) await stagePointer(version, resolve(release))
  console.log(`${version} is the generation already published, so there's nothing more to make`)
}
else {
  if (jar)
    await makeTiles(resolve(extract), resolve(jar), version)
  if (release)
    await stageMade(made, resolve(release))
}
