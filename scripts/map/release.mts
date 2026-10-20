// The map's OpenStreetMap data as GitHub releases: each generation is its own immutable release, tagged
// map-data-<version>, holding one archive of the walk, the gazetteer, the tiles, and a manifest with a hash of each,
// and the one mutable release, map-data, holds only latest.json, uploaded last, naming the generation builds take.
// A generation's version is its extract's date and its generator (src/shared/made.mts), so the same extract made
// again by changed code is a new generation, at a new URL

import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { checked } from "../../src/shared/json.mts"
import { type Chunks, contentHash } from "../../src/shared/hash.mts"
import { Made, versionOf } from "../../src/shared/made.mts"

const RELEASES = "https://github.com/wlib/notunh/releases/download/"
export const POINTER = `${RELEASES}map-data/latest.json`
export const ARCHIVE = "map-data.tar.gz"

export const archiveUrl = (version: string) =>
  `${RELEASES}map-data-${version}/${ARCHIVE}`

const Pointer = v.object({ version: v.string() })

/** What an archive holds, as its manifest.json says: where it came from, and each file's SHA-256, by path in it */
export const Manifest = v.object({ ...Made.entries, version: v.string(), files: v.record(v.string(), v.string()) })
export type Manifest = v.InferOutput<typeof Manifest>

// Everything whose change makes different data from the same extract, hashed with Planetiler's version
const GENERATOR = [
  "osm.mts", "pbf.mts", "walkable.mts", "gazetteer.mts", "tiles.mts", "campus.yml",
  "../../src/shared/made.mts", "../../src/map/basemap/tiles.mts", "../../src/places/gazetteer.mts",
  "../../src/geo/boxes.mts", "../../src/geo/lines.mts", "../../src/geo/projection.mts"
]

// The packages that code reads the extract and measures with, which, with all they depend on, are as much the
// generator as our code
const PACKAGES = ["@osmix/pbf", "cheap-ruler", "flatbush"]

type Locked = { version?: string, integrity?: string, dependencies?: Record<string, string> }

/** Where npm installed a package for one installed at a path, as Node resolves it: nested first, then each folder up */
const installedFor = (packages: Record<string, Locked>, from: string, name: string) => {
  for (let at = from; ; at = at.slice(0, Math.max(0, at.lastIndexOf("/node_modules/")))) {
    const path = `${at && `${at}/`}node_modules/${name}`
    if (packages[path])
      return path
    if (!at)
      throw new Error(`${name}, needed by ${from || "the generator"}, isn't in package-lock.json`)
  }
}

/** The packages as package-lock.json resolves them, with all they depend on, each by its path, version, and integrity */
export const lockedClosure = (packages: Record<string, Locked>, names: string[]) => {
  const found = new Set<string>()
  const visit = (path: string) => {
    if (found.has(path))
      return
    found.add(path)
    for (const name of Object.keys(packages[path].dependencies ?? {}))
      visit(installedFor(packages, path, name))
  }
  for (const name of names)
    visit(installedFor(packages, "", name))
  return [...found].sort().map(path => `${path} ${packages[path].version} ${packages[path].integrity}`)
}

/** The generator as it is now, with the packages locked and the Planetiler the workflow names in PLANETILER */
export const generator = async (planetiler = process.env.PLANETILER ?? "") => {
  const { packages } = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"))
  return contentHash(async function* () {
    yield `planetiler ${planetiler}\n`
    for (const locked of lockedClosure(packages, PACKAGES))
      yield `${locked}\n`
    for (const name of GENERATOR)
      yield await readFile(new URL(name, import.meta.url))
  }())
}

/** The manifest of some files, by path, each read as it's hashed, one at a time */
export const manifestOf = async (made: Made, files: Record<string, () => Chunks>): Promise<Manifest> => {
  const hashes: Record<string, string> = {}
  for (const [path, read] of Object.entries(files))
    hashes[path] = await contentHash(read())
  return { ...made, version: versionOf(made), files: hashes }
}

/** The files of a manifest that aren't as it says, missing or with other bytes, by path */
export const mismatches = (manifest: Manifest, hashOf: (path: string) => string | undefined) =>
  Object.entries(manifest.files).flatMap(([path, hash]) => hashOf(path) === hash ? [] : [path])

/** The pointer, or null while there's no release, which only a 404 means: anything else fails the build */
export const fetchPointer = async (load = fetch) => {
  const response = await load(POINTER)
  if (response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`${response.status} from ${POINTER}`)
  return checked(Pointer, await response.json(), POINTER)
}
