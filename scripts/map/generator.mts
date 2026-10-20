// What a map data generation is made by (scripts/map/osm.mts), whose hash is part of its version
// (src/shared/made.mts): our code that reads and shapes the extract, the packages it reads it and measures with, and
// Planetiler. So the same extract made again by changed code is a new generation, at a new URL

import { readFile } from "node:fs/promises"
import { contentHash } from "../../src/shared/hash.mts"

// Everything whose change makes different data from the same extract, hashed with Planetiler's version
const GENERATOR = [
  "osm.mts", "pbf.mts", "walkable.mts", "gazetteer.mts", "tiles.mts", "campus.yml",
  "../../src/shared/made.mts", "../../src/map/basemap/tiles.mts", "../../src/places/gazetteer.mts",
  "../../src/geo/boxes.mts", "../../src/geo/lines.mts", "../../src/geo/projection.mts"
]

// The packages that code reads the extract and measures with. With all they depend on, they're as much the
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
