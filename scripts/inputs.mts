// What a build of the site takes, each pinned to one generation of its release (scripts/release.mts): the inputs,
// everything acquired upstream and learned each night (scripts/data.mts), and the map data, made each week
// (scripts/map/osm.mts). A build takes the generation each pointer names as it starts, or the one NOTUNH_INPUTS or
// NOTUNH_MAP_DATA names: a version, or for the inputs, a folder laid out as the repository, given by a path starting
// with . or /, like ./inputs once made. With NOTUNH_OFFLINE, as pull requests are checked, the fixtures
// (tests/fixtures/data/) stand in for both and nothing is fetched. So a build never decides what to fetch or learn:
// it installs what it's given, or fails.
//
//   node scripts/inputs.mts              installs them, keeping what the site serves now beside them for the pages
//                                        open on it, then matches the places. public/inputs.json, served with the site,
//                                        records what's installed, and versions it names aren't fetched again
//   node scripts/inputs.mts --dev        likewise, for npm run dev: what a generation made before the campus pages
//                                        lacks (LATER_SOURCES) stays as installed, or else comes from the fixtures
//   node scripts/inputs.mts map-data     installs the map data alone, which making the inputs reads (scripts/data.mts)
//   node scripts/inputs.mts stage <to>   stages inputs/ in a folder to publish as a generation (inputs.yml)

import { LATER_SOURCES, installInputBundle, namedBy, validateInputs } from "./bundle.mts"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import * as v from "valibot"
import { contentHash } from "../src/shared/hash.mts"
import { localDay } from "../src/shared/time.mts"
import { TilesManifest } from "../src/map/basemap/tiles.mts"
import { FIXTURES, PUBLIC, REPO, STAGED, exists, isOffline, keepServed, run } from "./files.mts"
import { EVENTS } from "../src/social/sources.mts"
import type { EventsData } from "../src/social/event.mts"
import { NO_PREREQS, PREREQS } from "../src/programs/prereqs.mts"
import { OSM_PARKING } from "../src/parking/sources.mts"
import { deployed } from "./site.mts"
import { fetchGeneration, fetchPointer, hashesUnder, stage } from "./release.mts"
import { TILES, writeManifest } from "./map/tiles.mts"
import { keepServedStyle } from "./map/style.mts"
import { keepPublishedMenus } from "./dining/menus.mts"
import { COURSES, emptyIndex } from "../src/courses/course.mts"

/** For npm run dev, which keeps what a generation lacks, rather than a build, which ships only what it installs */
const isDev = process.argv.includes("--dev")

/** What's installed: the inputs' version or folder, and the map data's version, null offline */
type Installed = { inputs: string, "map-data": string | null }

const RECORD = new URL("inputs.json", PUBLIC)

/** A file of the repository, by its path in it */
const inRepo = (path: string) =>
  fileURLToPath(new URL(path, REPO))

/** The folder the inputs come from, by its path from the repository or its absolute path, unless they're a version */
const folderOf = (inputs: string) =>
  /^[./]/.test(inputs) ? inRepo(inputs) : undefined

/** What the build is to install, as the environment pins it, else as the pointers do now */
const pinned = async (): Promise<Installed> => {
  if (isOffline)
    return { inputs: `./${relative(fileURLToPath(REPO), fileURLToPath(FIXTURES))}`, "map-data": null }
  const [inputs, mapData] = await Promise.all(([["inputs", "NOTUNH_INPUTS"], ["map-data", "NOTUNH_MAP_DATA"]] as const).map(async ([kind, name]) => {
    const version = process.env[name] ?? (await fetchPointer(kind))?.version
    if (!version)
      throw new Error(`Nothing is released as ${kind} yet: run its workflow (docs/deploying.md)`)
    return version
  }))
  return { inputs, "map-data": mapData }
}

/**
 * Installs a map data generation, with the tiles the site serves now kept one more build beside the new ones, for
 * tabs still on them
 */
const installMapData = async (version: string) => {
  const serving = (await deployed("/map/", "tiles", TilesManifest))?.version
  const folder = await mkdtemp(join(tmpdir(), "notunh-map-data-"))
  try {
    const kept = [version]
    await fetchGeneration("map-data", version, join(folder, version))
    if (serving && serving !== version)
      await fetchGeneration("map-data", serving, join(folder, serving))
        .then(() => kept.push(serving), error => console.warn(`Not keeping the tiles of ${serving}: ${error.message}`))
    for (const name of kept)
      await cp(join(folder, name, "tiles"), fileURLToPath(new URL(`${name}/`, TILES)), { recursive: true })
    for (const file of ["walk.json", "gazetteer.json"])
      await cp(join(folder, version, file), inRepo(`src/map/${file}`))
    // The parking areas came later, and a generation made before them has none, so parking reads the extract instead
    await rm(inRepo(OSM_PARKING), { force: true })
    if (await exists(pathToFileURL(join(folder, version, "parking.json"))))
      await cp(join(folder, version, "parking.json"), inRepo(OSM_PARKING))
    await writeManifest(version)
    console.log(`Map data ${kept.join(", keeping the tiles of ")}`)
  }
  finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** What a later source is where there's none: no events, no terms, no prerequisites; parking always has its fixtures' */
const EMPTY: Record<string, unknown> = {
  [EVENTS]:  { fetched: 0, events: [] } satisfies EventsData,
  [COURSES]: emptyIndex(),
  [PREREQS]: NO_PREREQS
}

/** A later source as installed in a folder laid out as the repository, with the files it names, by path, or none */
const laterIn = async (root: URL, path: string) => {
  try {
    const index = await readFile(new URL(path, root))
    const files = await Promise.all(namedBy(JSON.parse(index.toString())).map(async url => [`public${url}`, await readFile(new URL(`public${url}`, root))] as const))
    return new Map([[path, index], ...files])
  }
  catch {}
}

/**
 * The files the site's data by a name names now, kept beside tonight's for one more build, for tabs still on the
 * index that names them. Gives back how many were kept
 */
const keepPublished = async (name: string) =>
  (await keepServed(namedBy(await deployed("/map/", name, v.object({ files: v.array(v.string()) }))))).length

/**
 * Installs the inputs and the map data in place of whatever was installed, everything under public/data/ included,
 * then keeps beside them what the site serves now, and matches the places. Offline, the fixtures are both, and
 * nothing's kept. A later source the generation lacks stays as it was installed or comes from the fixtures for npm
 * run dev, and is empty for a build, but for parking, whose fixtures' rules are as good as a night old
 */
const install = async ({ inputs, "map-data": mapData }: Installed) => {
  const folder = folderOf(inputs)
  const installed = isDev ? await Promise.all(LATER_SOURCES.map(path => laterIn(REPO, path))) : []
  if (folder)
    await installInputBundle(folder, inRepo("."), !isOffline)
  else {
    const fetched = await mkdtemp(join(tmpdir(), "notunh-inputs-"))
    try {
      const { files } = await fetchGeneration("inputs", inputs, fetched)
      await installInputBundle(fetched, inRepo("."), true, Object.keys(files))
    }
    finally {
      await rm(fetched, { recursive: true, force: true })
    }
  }
  if (mapData) {
    await installMapData(mapData)
    console.log(`Kept ${await keepServedStyle()} style files, ${await keepPublishedMenus()} dining files, ${await keepPublished("courses")} course files and ${await keepPublished("prereqs")} prerequisites files the site served`)
  }
  for (const [i, path] of LATER_SOURCES.entries()) {
    if (await exists(new URL(path, REPO)))
      continue
    const [from, files] =
      installed[i]              ? ["as installed", installed[i]] :
      isDev || !(path in EMPTY) ? ["from the fixtures", await laterIn(FIXTURES, path)] :
                                  ["empty", new Map([[path, JSON.stringify(EMPTY[path]) + "\n"]])]
    for (const [file, data] of files ?? [])
      await mkdir(new URL(".", new URL(file, REPO)), { recursive: true }).then(() => writeFile(new URL(file, REPO), data))
    console.log(`${path} ${from}, as inputs ${inputs} have none`)
  }
  await run(process.execPath, [fileURLToPath(new URL("map/places.mts", import.meta.url))])
  await writeFile(RECORD, JSON.stringify({ inputs, "map-data": mapData } satisfies Installed))
  console.log(`Inputs ${inputs}, map data ${mapData ?? "none"}`)
}

/**
 * Stages the inputs made in a folder to publish as a generation in another, named by the Durham day and a hash of
 * every file, unless it's the one published already
 */
export const stageInputs = async (folder: string, to: string, load = fetch) => {
  const files = await hashesUnder(folder)
  const version = `${localDay(Date.now())}-${(await contentHash(JSON.stringify(files))).slice(0, 8)}`
  return stage("inputs", { version, files }, folder, to, load)
}

if (import.meta.main) {
  const [command, to] = process.argv.slice(2)
  if (command === "stage") {
    await validateInputs(fileURLToPath(STAGED), true)
    await stageInputs(fileURLToPath(STAGED), to)
  }
  else if (command === "map-data") {
    const { "map-data": version } = await pinned()
    if (version)
      await installMapData(version)
  }
  else {
    const wanted = await pinned()
    const recorded = await readFile(RECORD, "utf8").then(JSON.parse, () => undefined)
    if (isDeepStrictEqual(recorded, wanted) && !folderOf(wanted.inputs))
      console.log(`Inputs ${wanted.inputs} and map data ${wanted["map-data"] ?? "none"} are installed already`)
    else
      await install(wanted)
  }
}
