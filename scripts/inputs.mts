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
//   node scripts/inputs.mts stage <to>   stages inputs/ in a folder to publish as a generation (inputs.yml)

import { INPUT_SOURCES, validateInputs } from "./bundle.mts"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { contentHash } from "../src/shared/hash.mts"
import { localDay } from "../src/shared/time.mts"
import { TilesManifest } from "../src/map/basemap/tiles.mts"
import { FIXTURES, PUBLIC, REPO, STAGED, isOffline, run } from "./files.mts"
import { deployed } from "./site.mts"
import { fetchGeneration, fetchPointer, hashesUnder, stage } from "./release.mts"
import { TILES, writeManifest } from "./map/tiles.mts"
import { keepServedStyle } from "./map/style.mts"
import { keepPublishedMenus } from "./dining/menus.mts"

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
      throw new Error(`Nothing is released as ${kind} yet: run its workflow (README, Deploying)`)
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
    await writeManifest(version)
    console.log(`Map data ${kept.join(", keeping the tiles of ")}`)
  }
  finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/**
 * Installs the inputs and the map data in place of whatever was installed, everything under public/data/ included,
 * then keeps beside them what the site serves now, and matches the places. Offline, the fixtures are both, and
 * nothing's kept
 */
const install = async ({ inputs, "map-data": mapData }: Installed) => {
  const clear = async () => {
    await rm(new URL("data/", PUBLIC), { recursive: true, force: true })
    for (const path of INPUT_SOURCES) await rm(inRepo(path), { force: true })
  }
  const folder = folderOf(inputs)
  if (folder) {
    await validateInputs(folder, !isOffline)
    await clear()
    await cp(folder, inRepo("."), { recursive: true })
  }
  else {
    const fetched = await mkdtemp(join(tmpdir(), "notunh-inputs-"))
    try {
      const { files } = await fetchGeneration("inputs", inputs, fetched)
      await validateInputs(fetched, true)
      await clear()
      for (const path of Object.keys(files))
        await cp(join(fetched, path), inRepo(path))
    }
    finally {
      await rm(fetched, { recursive: true, force: true })
    }
  }
  if (mapData) {
    await installMapData(mapData)
    console.log(`Kept ${await keepServedStyle()} style files and ${await keepPublishedMenus()} dining files the site served`)
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
  else {
    const wanted = await pinned()
    const recorded = await readFile(RECORD, "utf8").then(JSON.parse, () => undefined)
    if (isDeepStrictEqual(recorded, wanted) && !folderOf(wanted.inputs))
      console.log(`Inputs ${wanted.inputs} and map data ${wanted["map-data"] ?? "none"} are installed already`)
    else
      await install(wanted)
  }
}
