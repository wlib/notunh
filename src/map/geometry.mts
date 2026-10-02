// Pure geometry for the map: following trip shapes, moving buses along them,
// and keeping the camera clear of the panel

import type { Feed, Trip } from "./feed.mts"
import type { RideLeg } from "./plan.mts"

export type Coordinates = [number, number]

// A stop counts as reached once the shape passes this close, and passed once it's this far again
const CLOSE = 50 // m
const FAR = 200  // m

// Meters per degree around a latitude, flat-earth, fine at city scale
const scale = (lat: number) => ({ x: 111_320 * Math.cos(lat * Math.PI / 180), y: 110_540 })

const squaredMeters = ([lon, lat]: Coordinates, point: { lat: number, lon: number }) => {
  const { x, y } = scale(lat)
  return ((lon - point.lon) * x) ** 2 + ((lat - point.lat) * y) ** 2
}

/**
 * Each stop's vertex along a shape, in order: the closest point of the first close approach
 * after the previous stop's, so loops passing a stop twice stay in order
 */
export const indicesAlongShape = (shape: Coordinates[], stops: { lat: number, lon: number }[]) => {
  let index = 0
  return stops.map(stop => {
    let best = index
    let bestDistance = Infinity
    for (let i = index; i < shape.length; i++) {
      const d = squaredMeters(shape[i], stop)
      if (d < bestDistance) {
        best = i
        bestDistance = d
      }
      else if (bestDistance <= CLOSE ** 2 && d > FAR ** 2)
        break
    }
    return index = best
  })
}

const shapeIndices = new WeakMap<Trip, number[]>()

/** The street geometry a ride follows, from its boarding stop to where it gets off */
export const ridePath = (feed: Feed, leg: RideLeg): Coordinates[] => {
  const { trip } = leg.run
  const [first, last] = [leg.fromPosition, leg.toPosition]
    .map(position => feed.stops[trip.stops[position]])
    .map(({ lon, lat }): Coordinates => [lon, lat])
  const shape = feed.shapes[trip.shape]
  if (!shape)
    return [first, last]

  let indices = shapeIndices.get(trip)
  if (!indices) {
    indices = indicesAlongShape(shape, trip.stops.map(stop => feed.stops[stop]))
    shapeIndices.set(trip, indices)
  }
  return [first, ...shape.slice(indices[leg.fromPosition], indices[leg.toPosition] + 1), last]
}

export const segmentMeters = (a: Coordinates, b: Coordinates) => {
  const { x, y } = scale(a[1])
  return Math.hypot((b[0] - a[0]) * x, (b[1] - a[1]) * y)
}

/** Degrees clockwise from north */
export const bearing = (a: Coordinates, b: Coordinates) => {
  const { x, y } = scale(a[1])
  return (Math.atan2((b[0] - a[0]) * x, (b[1] - a[1]) * y) * 180 / Math.PI + 360) % 360
}

export const angleBetween = (a: number, b: number) =>
  Math.abs(((a - b) % 360 + 540) % 360 - 180)

/** A shape measured out for driving along */
export type Line = {
  coordinates: Coordinates[],
  /** Meters from the start to each vertex */
  distances: number[],
  length: number,
  /** Ends where it starts, so driving off the end carries on from the start */
  isLoop: boolean,
  /** Each stop the line's trips serve, by meters from the start, ascending */
  stops: { id: string, distance: number }[]
}

/** A shape and the stops of each trip along it */
export const toLine = (coordinates: Coordinates[], trips: { id: string, lat: number, lon: number }[][] = []): Line => {
  const distances = [0]
  for (let i = 1; i < coordinates.length; i++)
    distances.push(distances[i - 1] + segmentMeters(coordinates[i - 1], coordinates[i]))
  return {
    coordinates,
    distances,
    length: distances.at(-1)!,
    isLoop: coordinates.length > 2 && segmentMeters(coordinates[0], coordinates.at(-1)!) < 30,
    stops: [
      ...new Map(trips.flatMap(stops =>
        indicesAlongShape(coordinates, stops).map((index, i) => {
          const stop = { id: stops[i].id, distance: distances[index] }
          return [`${stop.id}@${stop.distance}`, stop] as const
        })
      )).values()
    ].sort((a, b) => a.distance - b.distance)
  }
}

const linesCache = new WeakMap<Feed, Map<string, Line[]>>()

/** Each route's lines: one per shape its trips follow, with those trips' stops along it */
export const routeLines = (feed: Feed) => {
  let lines = linesCache.get(feed)
  if (!lines) {
    lines = new Map(feed.routes.map(route => {
      const trips = feed.trips.filter(trip => trip.route === route.id)
      return [
        route.id,
        [...new Set(trips.map(trip => trip.shape))].map(shape =>
          toLine(
            feed.shapes[shape],
            trips
              .filter(trip => trip.shape === shape)
              .map(trip => trip.stops.map(stop => feed.stops[stop]))
          )
        )
      ]
    }))
    linesCache.set(feed, lines)
  }
  return lines
}

/** A position on a line, in meters from its start */
export type Track = {
  line:     Line,
  distance: number
}

/** Meters of distance worth an implausible move along the lines since the last report */
const continuity = (previous: Track, line: Line, distance: number) => {
  if (previous.line !== line)
    return SWITCH_WEIGHT
  const moved =
    line.isLoop
      ? ((distance - previous.distance) % line.length + line.length * 1.5) % line.length - line.length / 2
      : distance - previous.distance
  // Slightly preferring less movement settles ties between two passes over the same spot
  return Math.max(0, -STEP_BACK - moved, moved - STEP_AHEAD) / 2 + Math.abs(moved) / 100
}

/** Up to this far from every line, a bus isn't on its route (detours, the depot) */
const MAX_SNAP = 60 // m
/** Meters of distance that a bus heading the opposite way along a segment is worth */
const HEADING_WEIGHT = 50
/** How far along its line a bus plausibly gets between reports, back (GPS jitter) and forward */
const STEP_BACK = 30    // m
const STEP_AHEAD = 300  // m
/** Meters of distance that switching to another of the route's lines is worth */
const SWITCH_WEIGHT = 25

/**
 * The closest point on any of the lines, preferring segments that point the way the bus is heading
 * so the two directions along one street stay apart, and that follow on from where it last was
 * so it doesn't jump to another pass along the same street
 */
export const snapToLines = (lines: Line[], point: { lat: number, lon: number }, heading?: number, previous?: Track) => {
  const { x, y } = scale(point.lat)
  let best: Track | undefined
  let bestScore = Infinity

  for (const line of lines)
    for (let index = 0; index + 1 < line.coordinates.length; index++) {
      const [a, b] = [line.coordinates[index], line.coordinates[index + 1]]
      const ax = (a[0] - point.lon) * x
      const ay = (a[1] - point.lat) * y
      const dx = (b[0] - a[0]) * x
      const dy = (b[1] - a[1]) * y
      const length = Math.hypot(dx, dy)
      const t = length ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length ** 2)) : 0
      const meters = Math.hypot(ax + t * dx, ay + t * dy)
      if (meters > MAX_SNAP)
        continue

      const distance = line.distances[index] + t * (line.distances[index + 1] - line.distances[index])
      const score =
        meters +
        (heading === undefined ? 0 : angleBetween(heading, bearing(a, b)) / 180 * HEADING_WEIGHT) +
        (previous ? continuity(previous, line, distance) : 0)
      if (score < bestScore) {
        bestScore = score
        best = { line, distance }
      }
    }

  return best
}

/** Where a distance along a line is, wrapping around loops and stopping at the ends of other lines */
export const pointAt = ({ coordinates, distances, length, isLoop }: Line, distance: number) => {
  distance =
    isLoop
      ? (distance % length + length) % length
      : Math.min(length, Math.max(0, distance))

  // The segment holding the distance, by binary search
  let low = 0
  let high = coordinates.length - 2
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (distances[middle] <= distance)
      low = middle
    else
      high = middle - 1
  }

  const [a, b] = [coordinates[low], coordinates[low + 1]]
  const span = distances[low + 1] - distances[low]
  const t = span ? (distance - distances[low]) / span : 0
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as Coordinates,
    bearing: bearing(a, b)
  }
}

/** Where a straight line from a point ends up after some meters along a bearing */
export const project = (point: Coordinates, bearingDegrees: number, meters: number): Coordinates => {
  const { x, y } = scale(point[1])
  const radians = bearingDegrees * Math.PI / 180
  return [point[0] + Math.sin(radians) * meters / x, point[1] + Math.cos(radians) * meters / y]
}

/** Meters a screen pixel spans at a latitude and zoom, for maplibre's 512 px tiles */
export const metersPerPixel = (lat: number, zoom: number) =>
  40_075_016.686 * Math.cos(lat * Math.PI / 180) / 512 / 2 ** zoom

// A corner pushes an offset line out along its bisector, by up to this many times the offset
const MAX_MITER = 2

/** At each point of a line, the degrees east and north a meter to its right is, stretched at corners so an offset holds along both sides */
export const sideways = (points: Coordinates[]): Coordinates[] => {
  const unit = ([x, y]: [number, number]): [number, number] => {
    const length = Math.hypot(x, y)
    return length ? [x / length, y / length] : [0, 0]
  }
  return points.map((point, i) => {
    const { x, y } = scale(point[1])
    // Directions in meters in and out of the point, the same at the ends
    const [before, after] = [points[Math.max(0, i - 1)], points[Math.min(points.length - 1, i + 1)]]
    const inward = unit([(point[0] - before[0]) * x, (point[1] - before[1]) * y])
    const outward = unit([(after[0] - point[0]) * x, (after[1] - point[1]) * y])
    const [dx, dy] = i === 0 ? outward : i === points.length - 1 ? inward : unit([inward[0] + outward[0], inward[1] + outward[1]])
    const miter = 1 / Math.max(1 / MAX_MITER, dx * outward[0] + dy * outward[1])
    return [dy * miter / x, -dx * miter / y]
  })
}

/**
 * A line running alongside another, each point some meters to the right of it (left when negative).
 * Corners are mitered, and where an inside bend is tighter than the offset, the points that would double back are
 * dropped rather than looping. Lines offset again and again can pass in their sideways once, the slow part
 */
export const offsetLine = (points: Coordinates[], offsets: number[], right = sideways(points)): Coordinates[] => {
  const shifted = points.map(([lon, lat], i): Coordinates => [lon + right[i][0] * offsets[i], lat + right[i][1] * offsets[i]])
  // Kept points must go forward along the original line, not back against it
  const { x, y } = scale(points[0]?.[1] ?? 0)
  const kept = [0]
  for (let i = 1; i < points.length; i++) {
    const last = kept.at(-1)!
    const along = (points[i][0] - points[last][0]) * (shifted[i][0] - shifted[last][0]) * x * x +
      (points[i][1] - points[last][1]) * (shifted[i][1] - shifted[last][1]) * y * y
    if (along > 0 || i === points.length - 1)
      kept.push(i)
  }
  return kept.map(i => shifted[i])
}

export type Rect = { top: number, bottom: number, left: number, right: number, width: number, height: number }

export type Padding = { top: number, bottom: number, left: number, right: number }

/** Pads the side of the map the panel covers least of, wherever the CSS put it */
export const coveredPadding = (area: Rect, panel: Rect, margin = 48): Padding => {
  const padding = { top: margin, bottom: margin, left: margin, right: margin }
  if (
    panel.right <= area.left || panel.left >= area.right ||
    panel.bottom <= area.top || panel.top >= area.bottom
  )
    return padding

  const covered = {
    left:   (panel.right - area.left) / area.width,
    right:  (area.right - panel.left) / area.width,
    top:    (panel.bottom - area.top) / area.height,
    bottom: (area.bottom - panel.top) / area.height
  }
  const side = (Object.keys(covered) as (keyof typeof covered)[])
    .reduce((a, b) => covered[a] <= covered[b] ? a : b)
  padding[side] += covered[side] * (side === "left" || side === "right" ? area.width : area.height)
  return padding
}
