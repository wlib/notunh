// Map matching: where along some lines a thing that keeps to them is, like a bus to its route or a walker to a
// path, from fixes that come with error, a heading, and a time

import { type Line, along, distanceAt, nearestOnSegment, pointAt } from "./lines.mts"
import { type Coordinates, type Point, angleBetween, bearing, distance } from "./projection.mts"

/** A position on a line, in meters from its start */
export type Track<L extends Line = Line> = {
  line:     L,
  distance: number
}

/** Up to this far from every line, a thing isn't on them (detours, the depot) */
const MAX_SNAP = 60 // m
/** Meters of distance that heading the opposite way along a segment is worth */
const HEADING_WEIGHT = 50
/** How far along its line a thing plausibly gets between fixes, back (GPS jitter) and forward */
const STEP_BACK = 30    // m
const STEP_AHEAD = 300  // m
/** Meters of distance that switching to another of the lines is worth */
const SWITCH_WEIGHT = 25

/** Meters of distance worth an implausible move along the lines since the last fix */
const continuity = (previous: Track, line: Line, distance: number) => {
  if (previous.line !== line)
    return SWITCH_WEIGHT
  const moved = along(line, distance - previous.distance)
  // Slightly preferring less movement settles ties between two passes over the same spot
  return Math.max(0, -STEP_BACK - moved, moved - STEP_AHEAD) / 2 + Math.abs(moved) / 100
}

/**
 * The closest point on any of the lines, preferring segments that point the way the thing is heading so the two
 * directions along one street stay apart, and that follow on from where it last was so it doesn't jump to another
 * pass along the same street
 */
export const snapToLines = <L extends Line>(lines: readonly L[], point: Point, heading?: number, previous?: Track<L>) => {
  let best: Track<L> | undefined
  let bestScore = Infinity

  for (const line of lines)
    for (let index = 0; index + 1 < line.coordinates.length; index++) {
      const { t, meters } = nearestOnSegment(line, index, point)
      if (meters > MAX_SNAP)
        continue

      const distance = distanceAt(line, index, t)
      const score =
        meters +
        (heading === undefined ? 0 : angleBetween(heading, bearing(line.coordinates[index], line.coordinates[index + 1])) / 180 * HEADING_WEIGHT) +
        (previous ? continuity(previous, line, distance) : 0)
      if (score < bestScore) {
        bestScore = score
        best = { line, distance }
      }
    }

  return best
}

/** Where along some lines a moving thing was, and when */
export type Following<L extends Line = Line> = Track<L> & { at: number }

// Further along than its speed could take it, plus this, a fix has found some other stretch of a line, like the
// other side of the street
const LEEWAY = 30 // m
// Fixes further apart than this start afresh
const MAX_SKIP = 30_000 // ms

/**
 * Where along some lines a fix puts something that keeps to them, if it's within some meters of one and following
 * on from where it was at no more than some speed
 */
export const follow = <L extends Line>(
  lines: readonly L[],
  fix: Point & { heading?: number, at: number },
  previous: Following<L> | undefined,
  { within, speed }: { within: number, speed: number }
): (Following<L> & { point: Coordinates }) | undefined => {
  const recent = previous && fix.at - previous.at <= MAX_SKIP ? previous : undefined
  const track = snapToLines(lines, fix, fix.heading, recent)
  if (!track)
    return
  const { point } = pointAt(track.line, track.distance)
  const isOn = distance(fix, { lon: point[0], lat: point[1] }) <= within
  const isFollowing = !recent || track.line === recent.line &&
    Math.abs(along(track.line, track.distance - recent.distance)) <= LEEWAY + speed * (fix.at - recent.at) / 1000
  return isOn && isFollowing ? { ...track, at: fix.at, point } : undefined
}
