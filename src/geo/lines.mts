// Lines measured out in meters, each by a ruler of its own: where along one a point or a distance falls, the stretch
// between two distances, and fewer bends

import type CheapRuler from "cheap-ruler"
import { boxOf } from "./boxes.mts"
import { type Coordinates, type Point, bearing, ruler, segmentMeters } from "./projection.mts"

/** A line measured out for moving along */
export type Line = {
  coordinates: Coordinates[],
  /** Meters from the start to each vertex */
  distances: number[],
  length: number,
  /** Ends where it starts, so moving off the end carries on from the start */
  isLoop: boolean,
  /** Laid at the middle of the line, for measuring from points beside it, as a line is no wider than a town */
  ruler: CheapRuler
}

// A line ending this close to where it starts is a loop
const LOOP_GAP = 30 // m

/** A line measured out, each segment at its own latitude as every distance is, so its length adds up to them */
export const toLine = (coordinates: Coordinates[]): Line => {
  const distances = [0]
  for (let i = 1; i < coordinates.length; i++)
    distances.push(distances[i - 1] + segmentMeters(coordinates[i - 1], coordinates[i]))
  const [, south, , north] = boxOf(coordinates) ?? [0, 0, 0, 0]
  return {
    coordinates,
    distances,
    length: distances.at(-1)!,
    isLoop: coordinates.length > 2 && segmentMeters(coordinates[0], coordinates.at(-1)!) < LOOP_GAP,
    ruler: ruler((south + north) / 2)
  }
}

/** How far along a segment (dx, dy) the point nearest an offset (px, py) from its start is, as a fraction of it */
export const alongSegment = (px: number, py: number, dx: number, dy: number) =>
  dx || dy ? Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy))) : 0

/** A point's offset from one of a line's vertices, and the segment on from the vertex, in meters east and north */
const offsets = ({ coordinates, ruler: { kx, ky } }: Line, index: number, { lat, lon }: Point) => {
  const [a, b] = [coordinates[index], coordinates[index + 1]]
  return { px: (lon - a[0]) * kx, py: (lat - a[1]) * ky, dx: (b[0] - a[0]) * kx, dy: (b[1] - a[1]) * ky }
}

/** The nearest point of one of a line's segments to a point: how far along the segment as a fraction, and how far off it */
export const nearestOnSegment = (line: Line, index: number, point: Point) => {
  const { px, py, dx, dy } = offsets(line, index, point)
  const t = alongSegment(px, py, dx, dy)
  return { t, meters: Math.hypot(px - t * dx, py - t * dy) }
}

/** Meters along a line that a fraction of the way along one of its segments is */
export const distanceAt = ({ distances }: Line, index: number, t: number) =>
  distances[index] + t * (distances[index + 1] - distances[index])

/** The point on a line closest to another, as meters along the line, and meters away from it */
export const nearestOnLine = (line: Line, { lat, lon }: Point) => {
  const { index, t, dist } = line.ruler.pointOnLine(line.coordinates, [lon, lat])
  // The ruler leaves t past either end of the segment where the nearest point is its end
  return { distance: distanceAt(line, index, Math.min(1, Math.max(0, t))), meters: dist }
}

// A waypoint counts as reached once the line passes this close, and passed once it's this far again
const CLOSE = 50 // m
const FAR = 200  // m

/**
 * Meters along a line of each of some points in order along it: the closest point of the first close approach
 * after the one before, so a loop passing a point twice keeps them in order, and never before the one before,
 * which may be partway along the same segment
 */
export const positionsAlong = (line: Line, points: Point[]) => {
  const { coordinates, distances } = line
  let index = 0
  return points.map(point => {
    let best = index
    let bestDistance = Infinity
    for (let i = Math.floor(index); i + 1 < coordinates.length; i++) {
      const { px, py, dx, dy } = offsets(line, i, point)
      const t = Math.max(index - i, alongSegment(px, py, dx, dy))
      const d = Math.hypot(px - t * dx, py - t * dy)
      if (d < bestDistance) {
        best = i + t
        bestDistance = d
      }
      else if (bestDistance <= CLOSE && d > FAR)
        break
    }
    index = best
    const vertex = Math.min(Math.floor(best), coordinates.length - 2)
    return distances[vertex] + (best - vertex) * (distances[vertex + 1] - distances[vertex])
  })
}

/** The segment of a line holding a distance along it, by binary search */
export const segmentAt = ({ coordinates, distances }: Line, distance: number) => {
  let low = 0
  let high = coordinates.length - 2
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (distances[middle] <= distance)
      low = middle
    else
      high = middle - 1
  }
  return low
}

/** The point a distance along one of a line's segments */
const pointOnSegment = ({ coordinates, distances }: Line, index: number, distance: number): Coordinates => {
  const [a, b] = [coordinates[index], coordinates[index + 1]]
  const span = distances[index + 1] - distances[index]
  const t = span ? (distance - distances[index]) / span : 0
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Where a distance along a line is, wrapping around loops and stopping at the ends of other lines */
export const pointAt = (line: Line, distance: number) => {
  const { coordinates, length, isLoop } = line
  distance =
    isLoop
      ? (distance % length + length) % length
      : Math.min(length, Math.max(0, distance))
  const index = segmentAt(line, distance)
  return {
    point: pointOnSegment(line, index, distance),
    bearing: bearing(coordinates[index], coordinates[index + 1])
  }
}

/** Meters moved along a line, the short way around a loop */
export const along = ({ length, isLoop }: Line, moved: number) =>
  isLoop ? ((moved % length) + length * 1.5) % length - length / 2 : moved

/** The stretch of a line between two distances along it, backwards if the second comes first */
export const sliceLine = (line: Line, from: number, to: number): Coordinates[] => {
  if (from > to)
    return sliceLine(line, to, from).reverse()
  from = Math.max(0, from)
  to = Math.min(line.length, to)
  const [first, last] = [segmentAt(line, from), segmentAt(line, to)]
  return [
    pointOnSegment(line, first, from),
    ...line.coordinates.slice(first + 1, last + 1),
    pointOnSegment(line, last, to)
  ]
}

/** A line with every bend that strays less than some meters from a straighter one left out (Douglas–Peucker) */
export const simplify = (coordinates: Coordinates[], meters: number): Coordinates[] => {
  if (coordinates.length < 3)
    return coordinates
  const [a, b] = [coordinates[0], coordinates.at(-1)!]
  const { kx, ky } = ruler(a[1])
  const [dx, dy] = [(b[0] - a[0]) * kx, (b[1] - a[1]) * ky]
  let [worst, at] = [0, 0]
  for (let i = 1; i + 1 < coordinates.length; i++) {
    const [px, py] = [(coordinates[i][0] - a[0]) * kx, (coordinates[i][1] - a[1]) * ky]
    // From the segment rather than the line through it, so a stretch that doubles back on itself is kept
    const t = alongSegment(px, py, dx, dy)
    const off = Math.hypot(px - t * dx, py - t * dy)
    if (off > worst)
      [worst, at] = [off, i]
  }
  return worst <= meters
    ? [a, b]
    : [...simplify(coordinates.slice(0, at + 1), meters).slice(0, -1), ...simplify(coordinates.slice(at), meters)]
}
