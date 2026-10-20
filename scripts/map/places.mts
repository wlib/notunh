// Finds the buildings UNH's laundry rooms and dining halls are in, from OpenStreetMap, into src/map/places.json. The
// laundry vendor puts every room at the same spot, so rooms are matched to their residence halls by name instead,
// against the campus's buildings in the gazetteer, which scripts/map/osm.mts makes. A build runs it once its inputs
// are installed (scripts/inputs.mts), since it reads the rooms' and dining halls' names. The file records a hash of
// the gazetteer, rooms, menus, and code it was derived from. With --fixtures, it matches the fixtures' rooms and halls,
// as the Map data workflow checks a new gazetteer without asking anything of the laundry vendor or Nutrislice

import { readFile, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { slug } from "../../src/shared/slug.mts"
import { contentHash } from "../../src/shared/hash.mts"
import type { Building, Places } from "../../src/places/buildings.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { type Box, holds } from "../../src/geo/boxes.mts"
import { FIXTURES, REPO } from "../files.mts"

const OUTPUT   = new URL("../../src/map/places.json", import.meta.url)
const GAZETTEER = new URL("../../src/map/gazetteer.json", import.meta.url)
const SOURCES  = process.argv.includes("--fixtures") ? FIXTURES : REPO
const ROOMS    = new URL("src/laundry/rooms.json", SOURCES)
const MENUS    = new URL("src/dining/menus.json", SOURCES)

// UNH's Durham campus and the town around it, as west, south, east, north
const CAMPUS: Box = [-70.96, 43.125, -70.915, 43.15]

// Where OSM names a building otherwise than the laundry vendor or dining does. Woodside's one laundry room serves
// its whole complex of lettered apartment buildings from its community center, which UNH Housing lists among them
const ALIASES: Record<string, string> = {
  "Adams Tower":     "New England Center - Adams Tower",
  "Engelhardt Hall": "Englehardt Hall",
  "Gables North":    "Gables N",
  "Gables South":    "Gables S",
  "Woodside":        "Woodside Community Building"
}

const [gazetteerJson, roomsJson, menusJson] = await Promise.all([GAZETTEER, ROOMS, MENUS].map(url => readFile(url, "utf8")))
const inputs = [gazetteerJson, roomsJson, menusJson, await readFile(new URL(import.meta.url))]
const derivedFrom = (await contentHash(Readable.from(inputs.flatMap(input => [input, "\0"])), "base64url")).slice(0, 16)

// The campus's buildings by name, each where OSM has its middle
const { places: gazetteer }: Gazetteer = JSON.parse(gazetteerJson)
const coordinates = new Map(gazetteer
  .filter(place => place.kind === "building" && holds(CAMPUS, { lon: place.at[0], lat: place.at[1] }))
  .map(({ name, at: [lon, lat] }) => [name, { lat, lon }])
)

const unresolved: string[] = []

/** A place in a building OSM knows by its name, or by that with "Hall" after it, as "Hetzel" is "Hetzel Hall" */
const locate = (kind: Building["kind"], building: string, rooms?: string[]): Building[] => {
  const name = [building, `${building} Hall`].find(name => coordinates.has(ALIASES[name] ?? name))
  if (!name) {
    unresolved.push(building)
    return []
  }
  const { lat, lon } = coordinates.get(ALIASES[name] ?? name)!
  return [{ id: `${kind}/${slug(name)}`, kind, name, lat, lon, ...rooms ? { rooms } : {} }]
}

// A room's building is its name without the room or floor, as "Stoke Hall G05" is in Stoke Hall and "Hetzel 1st
// Floor" in Hetzel. Room slugs are as the laundry page's paths have them, which the tests check
const rooms: { name: string }[] = JSON.parse(roomsJson)
const buildings = Map.groupBy(rooms, room => room.name.replace(/ (G\d+|\d+(st|nd|rd|th) Floor)$/, ""))
const { halls }: { halls: { name: string }[] } = JSON.parse(menusJson)

const places = [
  ...[...buildings].flatMap(([building, rooms]) => locate("laundry", building, rooms.map(room => slug(room.name)))),
  ...halls.flatMap(hall => locate("dining", hall.name))
]
if (unresolved.length)
  throw new Error(`No building in OpenStreetMap for ${unresolved.join(", ")}; add it to ALIASES, or wait for map data that has it`)

await writeFile(OUTPUT, JSON.stringify({ inputs: derivedFrom, buildings: places } satisfies Places, null, 2) + "\n")
console.log(`${places.length} places`)
