// The one model of the ground every meter in the app is measured by: cheap-ruler's flat frame on the WGS84 ellipsoid,
// laid at the latitude of what's measured. It's exact to a part in a thousand for some kilometers around it. Distances
// between two places, along a line, and in a frame around an origin all agree. Nothing here knows of stops, routes,
// or the map

import CheapRuler from "cheap-ruler"

/** A position as GeoJSON has it: longitude, latitude */
export type Coordinates = [number, number]

/** A position as the APIs and the planner have it */
export type Point = { lat: number, lon: number }

/** Meters measured flat around a latitude, with its meters per degree of longitude (kx) and of latitude (ky) */
export const ruler = (lat: number) =>
  new CheapRuler(lat, "meters")

/** Meters between two coordinates, as the crow flies, measured at the latitude between them, so the same either way round */
export const segmentMeters = (a: Coordinates, b: Coordinates) =>
  ruler((a[1] + b[1]) / 2).distance(a, b)

/** Meters between two points, as the crow flies */
export const distance = (a: Point, b: Point) =>
  segmentMeters([a.lon, a.lat], [b.lon, b.lat])

/** Degrees clockwise from north */
export const bearing = (a: Coordinates, b: Coordinates) =>
  (ruler(a[1]).bearing(a, b) + 360) % 360

/** The smaller angle between two bearings */
export const angleBetween = (a: number, b: number) =>
  Math.abs(((a - b) % 360 + 540) % 360 - 180)

/** Where a straight line from a point ends up after some meters along a bearing */
export const project = (point: Coordinates, bearingDegrees: number, meters: number): Coordinates =>
  ruler(point[1]).destination(point, meters, bearingDegrees)

/** Meters east and north of an origin */
export type Meters = [number, number]

/** A flat frame around an origin, in meters east and north of it, for working out geometry in one place */
export const frame = (origin: Coordinates) => {
  const at = ruler(origin[1])
  return {
    toMeters: ([lon, lat]: Coordinates): Meters => [(lon - origin[0]) * at.kx, (lat - origin[1]) * at.ky],
    toCoordinates: ([east, north]: Meters): Coordinates => at.offset(origin, east, north)
  }
}
