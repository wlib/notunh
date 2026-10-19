// Boxes and outlines, in one order everywhere: west, south, east, north, as GeoJSON's bounding boxes are. Whatever
// has them another way, like OpenStreetMap or Photon, is turned into this at the edge

import Flatbush from "flatbush"
import type { Coordinates, Point } from "./projection.mts"

/** West, south, east, north */
export type Box = [number, number, number, number]

/** Some boxes indexed for finding those touching another, by their position among them, while there are any */
export const indexBoxes = (boxes: readonly Box[]) => {
  if (!boxes.length)
    return
  const index = new Flatbush(boxes.length)
  for (const box of boxes)
    index.add(...box)
  index.finish()
  return index
}

/** The box around some coordinates, or none */
export const boxOf = (coordinates: readonly Coordinates[]): Box | undefined =>
  coordinates.length
    ? coordinates.reduce<Box>(([west, south, east, north], [lon, lat]) =>
      [Math.min(west, lon), Math.min(south, lat), Math.max(east, lon), Math.max(north, lat)],
      [Infinity, Infinity, -Infinity, -Infinity]
    )
    : undefined

export const holds = ([west, south, east, north]: Box, { lat, lon }: Point) =>
  west <= lon && lon <= east && south <= lat && lat <= north

/** Whether a box lies wholly inside another */
export const isInside = ([west, south, east, north]: Box, [outerWest, outerSouth, outerEast, outerNorth]: Box) =>
  west >= outerWest && south >= outerSouth && east <= outerEast && north <= outerNorth

/** In square degrees, for sorting boxes by size */
export const area = ([west, south, east, north]: Box) =>
  (east - west) * (north - south)

/**
 * Whether a point is inside an outline of some rings, as GeoJSON polygons have them, by crossing an odd number of
 * edges on the way out, which puts a courtyard's hole outside
 */
export const outlineHolds = (rings: readonly (readonly Coordinates[])[], { lat, lon }: Point) => {
  let isInside = false
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [[x1, y1], [x2, y2]] = [ring[i], ring[j]]
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1)
        isInside = !isInside
    }
  return isInside
}
