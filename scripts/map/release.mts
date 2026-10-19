// The map's OpenStreetMap data as GitHub releases: each generation is its own immutable release, tagged
// map-data-<version>, holding one archive of the walk, the gazetteer, the tiles, and a manifest with a hash of each,
// and the one mutable release, map-data, holds only latest.json, uploaded last, naming the generation builds take.
// A generation's version is its extract's date and its generator (src/map/made.mts), so the same extract made
// again by changed code is a new generation, at a new URL

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { checked } from "../../src/shared/json.mts"
import { Made, versionOf } from "../../src/map/made.mts"

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
  "../../src/map/made.mts", "../../src/map/tiles.mts", "../../src/map/gazetteer.mts",
  "../../src/geo/boxes.mts", "../../src/geo/lines.mts", "../../src/geo/projection.mts"
]

/** The generator as it is now, with the Planetiler the workflow names in PLANETILER */
export const generator = async (planetiler = process.env.PLANETILER ?? "") => {
  const hash = createHash("sha256").update(`planetiler ${planetiler}\n`)
  for (const name of GENERATOR)
    hash.update(await readFile(new URL(name, import.meta.url)))
  return hash.digest("hex")
}

export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex")

export const manifestOf = (made: Made, files: Record<string, Uint8Array | string>): Manifest => ({
  ...made,
  version: versionOf(made),
  files:   Object.fromEntries(Object.entries(files).map(([path, data]) => [path, sha256(data)]))
})

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
