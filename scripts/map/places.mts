// Finds the buildings UNH's laundry rooms and dining halls are in, from OpenStreetMap, into src/map/places.json. The
// laundry vendor puts every room at the same spot, so rooms are matched to their residence halls by name instead,
// against the checked-in building coordinates. Refresh those with --refresh from one Overpass query. Run after
// the laundry rooms and dining menus, whose names it reads. With --if-missing, places already there are kept

import { readFile, writeFile } from "node:fs/promises"
import { getJson } from "../../src/shared/json.mts"
import { slug } from "../../src/shared/slug.mts"
import type { Building } from "../../src/map/places.mts"
import { isKept } from "../files.mts"

const OVERPASS = "https://overpass-api.de/api/interpreter"
const OUTPUT   = new URL("../../src/map/places.json", import.meta.url)
const BUILDINGS = new URL("./buildings.json", import.meta.url)
const ROOMS    = new URL("../../src/laundry/rooms.json", import.meta.url)
const MENUS    = new URL("../../src/dining/menus.json", import.meta.url)

// UNH's Durham campus and the town around it, as south, west, north, east
const CAMPUS = [43.125, -70.96, 43.15, -70.915]

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

type Point = { lat: number, lon: number }
type Element = {
  tags:      { name: string },
  /** A way's outline */
  geometry?: Point[],
  /** A relation's extent */
  bounds?:   { minlat: number, minlon: number, maxlat: number, maxlon: number }
}

// The middle of a building's outline by area, taken relative to its first corner so the sums stay precise, else of
// its extent
const middleOf = ({ geometry, bounds }: Element): Point => {
  if (!geometry)
    return { lat: (bounds!.minlat + bounds!.maxlat) / 2, lon: (bounds!.minlon + bounds!.maxlon) / 2 }
  const [origin] = geometry
  let [area, lat, lon] = [0, 0, 0]
  for (const [i, a] of geometry.entries()) {
    const b = geometry[(i + 1) % geometry.length]
    const [x1, y1, x2, y2] = [a.lon - origin.lon, a.lat - origin.lat, b.lon - origin.lon, b.lat - origin.lat]
    const cross = x1 * y2 - x2 * y1
    area += cross
    lon += (x1 + x2) * cross
    lat += (y1 + y2) * cross
  }
  return { lat: origin.lat + lat / (3 * area), lon: origin.lon + lon / (3 * area) }
}

const round = (x: number) =>
  Math.round(x * 1e5) / 1e5

let coordinates: Record<string, Point> = JSON.parse(await readFile(BUILDINGS, "utf8"))
if (process.argv.includes("--refresh")) {
  const query = `[out:json][timeout:25];wr["building"]["name"](${CAMPUS.join(",")});out geom;`
  // Overpass turns away requests that don't say who's asking
  const { elements } = await getJson<{ elements: Element[] }>(OVERPASS, {
    method:  "POST",
    headers: { "User-Agent": "notunh (https://notunh.app)" },
    body:    new URLSearchParams({ data: query })
  })

  coordinates = Object.fromEntries(elements.map(element => {
    const { lat, lon } = middleOf(element)
    return [element.tags.name, { lat: round(lat), lon: round(lon) }]
  }))
  await writeFile(BUILDINGS, JSON.stringify(coordinates, null, 2) + "\n")
}

const unresolved: string[] = []

/** A place in a building OSM knows by its name, or by that with "Hall" after it, as "Hetzel" is "Hetzel Hall" */
const locate = (kind: Building["kind"], building: string, rooms?: string[]): Building[] => {
  const name = [building, `${building} Hall`].find(name => coordinates[ALIASES[name] ?? name])
  if (!name) {
    unresolved.push(building)
    return []
  }
  const { lat, lon } = coordinates[ALIASES[name] ?? name]
  return [{ id: `${kind}/${slug(name)}`, kind, name, lat: round(lat), lon: round(lon), ...rooms ? { rooms } : {} }]
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
  throw new Error(`No building in OpenStreetMap for ${unresolved.join(", ")}; run npm run places:refresh or add it to ALIASES`)

await writeFile(OUTPUT, JSON.stringify(places, null, 2) + "\n")
console.log(`${places.length} places`)
