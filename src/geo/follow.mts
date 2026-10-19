// Map matching: where along some lines a thing that keeps to them is, like a bus to its route or a walker to a
// path, from fixes that come with error, a heading, and a time

import { type Line, along, distanceAt, nearestOnSegment, pointAt } from "./lines.mts"
import { type Coordinates, type Point, angleBetween, bearing, distance } from "./projection.mts"

/** A position on a line, in meters from its start */
export type Track<L extends Line = Line> = {
  line:     L,
  distance: number
}

/**
 * How a kind of thing keeps to its lines, which a bus along its route and a walker along a path don't alike: what
 * the geometry here weighs, with the weights its callers' to say
 */
export type Tracking = {
  /** Up to this far from every line, the thing isn't on them */
  snap:      number,
  /** Meters of distance that heading the opposite way along a segment is worth */
  heading:   number,
  /** How far along its line it plausibly gets between fixes, back and forward */
  back:      number,
  ahead:     number,
  /** Meters of distance that switching to another of the lines is worth */
  switching: number,
  /** Further along than its speed could take it, plus this, a fix has found some other stretch of a line, like the other side of the street */
  leeway:    number,
  /** Fixes further apart than this many milliseconds start afresh */
  maxSkip:   number
}

/** Meters of distance worth an implausible move along the lines since the last fix */
const continuity = (previous: Track, line: Line, distance: number, { back, ahead, switching }: Tracking) => {
  if (previous.line !== line)
    return switching
  const moved = along(line, distance - previous.distance)
  // Slightly preferring less movement settles ties between two passes over the same spot
  return Math.max(0, -back - moved, moved - ahead) / 2 + Math.abs(moved) / 100
}

/**
 * The closest point on any of the lines, preferring segments that point the way the thing is heading so the two
 * directions along one street stay apart, and that follow on from where it last was so it doesn't jump to another
 * pass along the same street
 */
export const snapToLines = <L extends Line>(lines: readonly L[], point: Point, heading: number | undefined, previous: Track<L> | undefined, tracking: Tracking) => {
  let best: Track<L> | undefined
  let bestScore = Infinity

  for (const line of lines)
    for (let index = 0; index + 1 < line.coordinates.length; index++) {
      const { t, meters } = nearestOnSegment(line, index, point)
      if (meters > tracking.snap)
        continue

      const distance = distanceAt(line, index, t)
      const score =
        meters +
        (heading === undefined ? 0 : angleBetween(heading, bearing(line.coordinates[index], line.coordinates[index + 1])) / 180 * tracking.heading) +
        (previous ? continuity(previous, line, distance, tracking) : 0)
      if (score < bestScore) {
        bestScore = score
        best = { line, distance }
      }
    }

  return best
}

/** Where along some lines a moving thing was, and when */
export type Following<L extends Line = Line> = Track<L> & { at: number }

/**
 * Where along some lines a fix puts something that keeps to them, if it's within some meters of one and following
 * on from where it was at no more than some speed, in meters a second
 */
export const follow = <L extends Line>(
  lines: readonly L[],
  fix: Point & { heading?: number, at: number },
  previous: Following<L> | undefined,
  tracking: Tracking & { within: number, speed: number }
): (Following<L> & { point: Coordinates }) | undefined => {
  const recent = previous && fix.at - previous.at <= tracking.maxSkip ? previous : undefined
  const track = snapToLines(lines, fix, fix.heading, recent, tracking)
  if (!track)
    return
  const { point } = pointAt(track.line, track.distance)
  const isOn = distance(fix, { lon: point[0], lat: point[1] }) <= tracking.within
  const isFollowing = !recent || track.line === recent.line &&
    Math.abs(along(track.line, track.distance - recent.distance)) <= tracking.leeway + tracking.speed * (fix.at - recent.at) / 1000
  return isOn && isFollowing ? { ...track, at: fix.at, point } : undefined
}
