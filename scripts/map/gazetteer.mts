// The places OpenStreetMap names, from its elements, as the compact gazetteer the map searches and names spots by:
// each place's name, kind, middle, and extent, and each building's outline and doors

import type { OsmElement, OsmNode, OsmRelation, OsmWay } from "./pbf.mts"
import { type GazetteerPlace, PLACE_KEYS, kindOf } from "../../src/map/gazetteer.mts"
import type { Box } from "../../src/geo/boxes.mts"
import { type Coordinates, type Point } from "../../src/geo/projection.mts"

// Doors that aren't a way in or out for anyone walking somewhere
const NOT_DOORS = new Set(["no", "emergency", "exit", "service", "garage"])

/** Hundred-thousandths of a degree, about a meter */
const round = (degrees: number) =>
  Math.round(degrees * 1e5) / 1e5

const coordinates = ({ lon, lat }: Point): Coordinates =>
  [round(lon), round(lat)]

/**
 * The middle of an outline by area, taken relative to its first corner so the sums stay precise, else of its extent,
 * as for a relation of many outlines, and of a line or a point, which have no area
 */
export const middleOf = ({ geometry, bounds }: Pick<OsmWay, "geometry" | "bounds">): Point => {
  const area = geometry?.length ? areaOf(geometry) : 0
  if (!area)
    return { lat: (bounds![1] + bounds![3]) / 2, lon: (bounds![0] + bounds![2]) / 2 }
  const [origin] = geometry!
  let [lat, lon] = [0, 0]
  for (const [i, a] of geometry!.entries()) {
    const b = geometry![(i + 1) % geometry!.length]
    const [x1, y1, x2, y2] = [a.lon - origin.lon, a.lat - origin.lat, b.lon - origin.lon, b.lat - origin.lat]
    const cross = x1 * y2 - x2 * y1
    lon += (x1 + x2) * cross
    lat += (y1 + y2) * cross
  }
  return { lat: origin.lat + lat / (3 * area), lon: origin.lon + lon / (3 * area) }
}

/** Twice the signed area of an outline, in square degrees, which is 0 for a line or a point */
const areaOf = (geometry: Point[]) => {
  const [origin] = geometry
  return geometry.reduce((sum, a, i) => {
    const b = geometry[(i + 1) % geometry.length]
    return sum + (a.lon - origin.lon) * (b.lat - origin.lat) - (b.lon - origin.lon) * (a.lat - origin.lat)
  }, 0)
}

const kindOfTags = (tags: Record<string, string>) =>
  PLACE_KEYS.map(key => tags[key] && kindOf(key, tags[key])).find(Boolean)

/** An element's outline as rings: a way's own, or a relation's outer and inner parts, each where it closes on itself */
const ringsOf = (element: OsmWay | OsmRelation) =>
  (element.type === "way" ? [element.geometry ?? []] : element.members.flatMap(member => member.geometry ? [member.geometry] : []))
    .filter(ring => ring.length >= 4 && key(ring[0]) === key(ring.at(-1)!))

/** Every corner of an element's outline, a relation's across its parts */
const cornersOf = (element: OsmWay | OsmRelation) =>
  element.type === "way"
    ? element.geometry ?? []
    : element.members.flatMap(member => member.geometry ?? [])

const key = ({ lon, lat }: Point) =>
  `${lon},${lat}`

/**
 * The named places among some elements, by name, and the doors of the buildings among them, which are the entrances
 * on their outlines
 */
export const gazetteerOf = (elements: OsmElement[]): GazetteerPlace[] => {
  const doors = new Set(
    elements
      .filter((element): element is OsmNode => element.type === "node" && !!element.tags?.entrance && !NOT_DOORS.has(element.tags.entrance))
      .map(key)
  )

  const places = elements.flatMap((element): GazetteerPlace[] => {
    const name = element.tags?.name
    const kind = element.tags && kindOfTags(element.tags)
    if (!name || !kind)
      return []
    if (element.type === "node")
      return [{ name, kind, at: coordinates(element) }]

    const { bounds } = element
    const entrances = kind === "building"
      ? [...new Map(cornersOf(element).filter(corner => doors.has(key(corner))).map(corner => [key(corner), coordinates(corner)])).values()]
      : []
    // Only buildings keep their outlines, for telling which one a spot is in; a ring's last corner repeats its first
    const outline = kind === "building" ? ringsOf(element).map(ring => ring.slice(0, -1).map(coordinates)) : []
    return [{
      name,
      kind,
      at: coordinates(middleOf(element.type === "way" ? element : { bounds })),
      ...bounds ? { extent: bounds.map(round) as Box } : {},
      ...outline.length ? { outline } : {},
      ...entrances.length ? { entrances } : {}
    }]
  })
  return places.sort((a, b) => a.name.localeCompare(b.name, "en") || a.at[0] - b.at[0] || a.at[1] - b.at[1])
}
