// Finds the buildings UNH's laundry rooms and dining halls are in, from OpenStreetMap, into src/map/places.json. The
// laundry vendor puts every room at the same spot, so rooms are matched to their residence halls by name instead,
// against the campus's buildings in the gazetteer, which scripts/map/osm.mts refreshes. Run after the laundry rooms
// and dining menus, whose names it reads. With --if-missing, places already there are kept

import { readFile, writeFile } from "node:fs/promises"
import { slug } from "../../src/shared/slug.mts"
import type { Building } from "../../src/map/places.mts"
import { isKept } from "../files.mts"
import type { Gazetteer } from "../../src/map/gazetteer.mts"
import { type Box, holds } from "../../src/geo/boxes.mts"

const OUTPUT   = new URL("../../src/map/places.json", import.meta.url)
const GAZETTEER = new URL("../../src/map/gazetteer.json", import.meta.url)
const ROOMS    = new URL("../../src/laundry/rooms.json", import.meta.url)
const MENUS    = new URL("../../src/dining/menus.json", import.meta.url)

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

if (await isKept(OUTPUT))
  process.exit(0)

// The campus's buildings by name, each where OSM has its middle
const { places: gazetteer }: Gazetteer = JSON.parse(await readFile(GAZETTEER, "utf8"))
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
const rooms: { name: string }[] = JSON.parse(await readFile(ROOMS, "utf8"))
const buildings = Map.groupBy(rooms, room => room.name.replace(/ (G\d+|\d+(st|nd|rd|th) Floor)$/, ""))
const { halls }: { halls: { name: string }[] } = JSON.parse(await readFile(MENUS, "utf8"))

const places = [
  ...[...buildings].flatMap(([building, rooms]) => locate("laundry", building, rooms.map(room => slug(room.name)))),
  ...halls.flatMap(hall => locate("dining", hall.name))
]
if (unresolved.length)
  throw new Error(`No building in OpenStreetMap for ${unresolved.join(", ")}; run npm run osm:refresh or add it to ALIASES`)

await writeFile(OUTPUT, JSON.stringify(places, null, 2) + "\n")
console.log(`${places.length} places`)
