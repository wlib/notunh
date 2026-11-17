// Makes the buildings' profiles the map shows on a building's page, src/map/profiles.json, from the records kept by
// hand in src/places/profiles/, one <slug>.json each (src/places/profiles.mts), keyed by the gazetteer's name for each
// building. A build runs it once its map data is installed (scripts/inputs.mts), as it checks each record's place
// against the gazetteer as the map loads it, and the Map data workflow runs it against a new gazetteer before
// publishing one. Any record that isn't one, any citation of a source its record doesn't have, and any building named
// twice or not on the map fails it, listing every problem

import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { profilesOf } from "../../src/places/profiles.mts"
import { REPO } from "../files.mts"

/** Where the records are kept */
export const RECORDS = new URL("src/places/profiles/", REPO)

/** Every record in a folder, by file name, parsed */
export const readRecords = async (folder = fileURLToPath(RECORDS)) =>
  Promise.all((await readdir(folder)).filter(file => file.endsWith(".json")).sort().map(async file =>
    [file, JSON.parse(await readFile(join(folder, file), "utf8"))] as const))

if (import.meta.main) {
  const gazetteer = v.parse(Gazetteer, JSON.parse(await readFile(new URL("src/map/gazetteer.json", REPO), "utf8")))
  const { data, problems } = profilesOf(await readRecords(), new Set(gazetteer.places.map(place => place.name)))
  if (problems.length)
    throw new Error(`${problems.length} problems with the records in src/places/profiles/:\n${problems.join("\n")}`)
  await writeFile(new URL("src/map/profiles.json", REPO), JSON.stringify(data) + "\n")
  console.log(`${Object.keys(data.profiles).length} profiles, ${data.ranked} buildings ranked`)
}
