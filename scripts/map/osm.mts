// OpenStreetMap, from one extract of New Hampshire: the streets and paths people walk around Durham, as the network
// at src/map/walk.json, the places people go, as the gazetteer at src/map/gazetteer.json, and with Planetiler, our
// own map tiles (scripts/map/tiles.mts), all three marked with where they came from (src/map/made.mts). Each week
// the Map data workflow makes them from Geofabrik's latest extract and publishes them as a release (release.mts):
//
//   node scripts/map/osm.mts <extract.osm.pbf> <planetiler.jar> [--release <folder>]
//
// which, given a folder, leaves the archive, its manifest, and the pointer there to publish, unless the pointer
// already names this very generation. Without an extract, the build takes the generation the pointer names: the
// archive is fetched, its hashes checked, and only then swapped in, whole, with the tiles the site serves now kept
// beside the new ones for one more build, so a tab on the last build isn't left without. While there's no release,
// the walk and gazetteer are the fixtures', and the tiles all OpenFreeMap's. With --if-missing, tiles already there
// are kept

import { createReadStream } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { checked } from "../../src/shared/json.mts"
import { elementsWithin } from "./pbf.mts"
import type { Box } from "../../src/geo/boxes.mts"
import { HIGHWAYS, walkGraph } from "./walkable.mts"
import { gazetteerOf } from "./gazetteer.mts"
import { PLACE_KEYS } from "../../src/map/gazetteer.mts"
import { type Made, versionOf } from "../../src/map/made.mts"
import { TilesManifest } from "../../src/map/tiles.mts"
import { MANIFEST, TILES, makeTiles, writeManifest } from "./tiles.mts"
import { ARCHIVE, Manifest, archiveUrl, fetchPointer, generator, manifestOf, mismatches } from "./release.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { fromFixtures, isKept } from "../files.mts"
import { deployed } from "../site.mts"

const WALK      = new URL("../../src/map/walk.json", import.meta.url)
const GAZETTEER = new URL("../../src/map/gazetteer.json", import.meta.url)

// Durham, from Lee to the bay, and from Madbury to Packers Falls
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

const run = (command: string, args: string[], input?: Response) =>
  new Promise<void>((done, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] })
    child.on("error", reject).on("exit", code => code === 0 ? done() : reject(new Error(`${command} exited with ${code}`)))
    if (input)
      pipeline(Readable.fromWeb(input.body as any), child.stdin!).catch(reject)
  })

/** Every file under a folder, by its path from there */
const filesUnder = async (folder: string) =>
  (await readdir(folder, { withFileTypes: true, recursive: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(folder, join(entry.parentPath, entry.name)))

/** Stages a generation to publish: its archive, the manifest beside it to read, and the pointer to upload last */
const stage = async (made: Made, folder: string) => {
  const version = versionOf(made)
  const files = join(folder, "files")
  await rm(folder, { recursive: true, force: true })
  await mkdir(files, { recursive: true })
  await cp(WALK, join(files, "walk.json"))
  await cp(GAZETTEER, join(files, "gazetteer.json"))
  await cp(fileURLToPath(new URL(`${version}/`, TILES)), join(files, "tiles"), { recursive: true })
  const manifest = JSON.stringify(await manifestOf(made, Object.fromEntries((await filesUnder(files)).map(path => [path, () => createReadStream(join(files, path))]))))
  await writeFile(join(files, "manifest.json"), manifest)
  await run("tar", ["-czf", join(folder, ARCHIVE), "-C", files, "."])
  await writeFile(join(folder, "manifest.json"), manifest)
  await writeFile(join(folder, "latest.json"), JSON.stringify({ version }))
  await rm(files, { recursive: true })
  console.log(`Staged ${version} in ${folder}`)
}

/** A generation's archive, fetched into a folder and checked against its manifest, which fails on any difference */
const fetchGeneration = async (version: string, folder: string) => {
  const url = archiveUrl(version)
  const response = await fetch(url)
  if (!response.ok || !response.body)
    throw new Error(`${response.status} from ${url}`)
  await mkdir(folder, { recursive: true })
  await run("tar", ["-xzf", "-", "-C", folder], response)
  const manifest = await checked(Manifest, JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")), url)
  if (manifest.version !== version)
    throw new Error(`${url} holds ${manifest.version}`)
  // A file that isn't there has no hash, which no manifest names
  const hashes = new Map<string, string>()
  for (const path of Object.keys(manifest.files))
    hashes.set(path, await contentHash(createReadStream(join(folder, path))).catch(() => ""))
  const wrong = mismatches(manifest, path => hashes.get(path))
  if (wrong.length)
    throw new Error(`${url} isn't as its manifest says, at ${wrong.slice(0, 5).join(", ")}${wrong.length > 5 ? ` and ${wrong.length - 5} more` : ""}`)
}

/** The generation the pointer names, or while there's none, the fixtures' walk and gazetteer and no tiles */
const fromRelease = async () => {
  const pointer = await fetchPointer()
  if (!pointer) {
    console.log("No map data released yet, so the walk and gazetteer are the fixtures', and the tiles all OpenFreeMap's")
    await Promise.all(["src/map/walk.json", "src/map/gazetteer.json"].map(fromFixtures))
    await writeManifest()
    return
  }
  const { version } = pointer
  // The tiles the site serves now stay deployed one more build, for tabs still on it
  const serving = (await deployed("/map/", "tiles", TilesManifest))?.version
  const folder = await mkdtemp(join(tmpdir(), "notunh-map-data-"))
  try {
    const kept = [version]
    await fetchGeneration(version, join(folder, version))
    if (serving && serving !== version)
      await fetchGeneration(serving, join(folder, serving))
        .then(() => kept.push(serving), error => console.warn(`Not keeping the tiles of ${serving}: ${error.message}`))
    await rm(TILES, { recursive: true, force: true })
    for (const name of kept)
      await cp(join(folder, name, "tiles"), fileURLToPath(new URL(`${name}/`, TILES)), { recursive: true })
    await cp(join(folder, version, "walk.json"), WALK)
    await cp(join(folder, version, "gazetteer.json"), GAZETTEER)
    await writeManifest(version)
    console.log(`Map data ${kept.join(", keeping the tiles of ")}`)
  }
  finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const release = args.includes("--release") ? args[args.indexOf("--release") + 1] : undefined
const [extract, jar] = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--release")
if (extract) {
  const made = await fromExtract(extract)
  const version = versionOf(made)
  if ((await fetchPointer().catch(() => null))?.version === version)
    console.log(`${version} is the generation already published, so there's nothing more to make`)
  else {
    if (jar)
      await makeTiles(resolve(extract), resolve(jar), version)
    if (release)
      await stage(made, resolve(release))
  }
}
else if (!await isKept(MANIFEST))
  await fromRelease()
