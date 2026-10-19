// What a bus did between two reports along its route: the stops whose zones it entered and left, and when, timed by
// interpolating between the two. The map reads a bus's crossings as it reports to learn how its line is running
// (pace.mts), and the nightly build reads a day's from the Worker's samples to learn the model (events.mts); neither
// gets to see the other's evidence

import type { Track } from "../geo/follow.mts"
import { type RouteLine, firstAhead, lapOf, stopAt } from "./shapes.mts"

/** m around a stop where a bus is at it, pulling in, waiting, or pulling out */
export const ZONE = 25
// Implausible paces, from a bus that parked or a snap onto the wrong line
export const MIN_RATE = 0.5 // m/s
const MAX_RATE = 30         // m/s
// Further than this between reports, it's not the same trip
const MAX_JUMP = 2000       // m
// Longer than this between reports, there's no telling what it did in between, and moving, it could have stopped
// anywhere on the way: moving buses report every 11 s or so, and stopped ones every 30
const MAX_GAP = 120         // s
const MAX_STEP = 45         // s
// GPS wanders this far back along the street while a bus sits still
const JITTER = 30           // m
// Slower is idling at a stop, with a meaningless heading
export const MIN_MOVING_KPH = 3

/** One bus's last report, and what it was last seen doing at stops */
export type Trace = {
  track: Track<RouteLine>,
  /** Epoch seconds of the report */
  at: number,
  /** The bus wasn't moving */
  isStopped: boolean,
  /** It wasn't moving in the report before either, so it's parked or held up for a while */
  isStill?: boolean,
  /** The zone it's in, and when it entered */
  entered?: { stop: number, at: number },
  /** The last zone it left, and when */
  left?: { stop: number, at: number },
  /** Epoch seconds its trip is scheduled to leave stops where it waits for that, by stop id */
  holds?: ReadonlyMap<string, number>
}

/** What a bus did between two reports: drove from one stop's zone to the next, or went through a stop's zone */
export type Crossing =
  | { kind: "drive", from: string, to: string, meters: number, start: number, end: number }
  | { kind: "zone", stop: string, arrive: number, depart: number }

/** m driven between the zones of two stops some distance apart */
export const driven = (from: { distance: number }, to: { distance: number }) =>
  to.distance - from.distance - 2 * ZONE

/**
 * The zone edges a bus crossed since its last report, timed by interpolating between the two reports
 * @returns its trace as of the new report, and the drives and stops it finished in between, in order
 */
export const cross = (previous: Trace | undefined, track: Track<RouteLine>, at: number, isStopped: boolean) => {
  const { line } = track
  const crossings: Crossing[] = []
  const isSameRun = previous?.track.line === line && at > previous.at && at - previous.at <= MAX_GAP
  const isStill = isStopped && previous?.isStopped
  if (!isSameRun || !line.stops.length)
    return { trace: { track, at, isStopped, isStill } as Trace, crossings }

  const from = previous.track.distance
  const moved =
    line.isLoop
      ? ((track.distance - from) % line.length + line.length) % line.length
      : track.distance - from
  // A little way back is the GPS wandering, so the bus stays where it got to
  if (moved < 0 ? moved >= -JITTER : line.isLoop && moved >= line.length - JITTER)
    return { trace: { ...previous, at, isStopped, isStill }, crossings }
  if (moved < 0 || moved > MAX_JUMP || (moved > JITTER && at - previous.at > MAX_STEP))
    return { trace: { track, at, isStopped, isStill } as Trace, crossings }

  const timeAt = (distance: number) => previous.at + (moved ? (distance - from) / moved : 1) * (at - previous.at)
  // Every zone edge crossed, in order along the line, from the first stop whose zone ends past where the bus was
  const lap = lapOf(line, from - ZONE)
  let { entered, left } = previous
  for (let i = firstAhead(line, from - ZONE); ; i++) {
    if (!line.isLoop && i >= line.stops.length)
      break
    const stop = stopAt(line, lap, i)
    if (stop.distance - ZONE > from + moved)
      break

    if (stop.distance - ZONE > from) {
      const time = timeAt(stop.distance - ZONE)
      const previousStop = stopAt(line, lap, i - 1)
      if (left?.stop === previousStop.index && (line.isLoop || i > 0)) {
        const meters = driven(previousStop, stop)
        const rate = meters / (time - left.at)
        // Stops whose zones overlap have nothing between them to drive, and a negative distance over a negative time
        // would pass for a rate
        if (meters > 0 && rate >= MIN_RATE && rate <= MAX_RATE)
          crossings.push({ kind: "drive", from: previousStop.id, to: stop.id, meters, start: left.at, end: time })
      }
      entered = { stop: stop.index, at: time }
    }
    if (stop.distance + ZONE > from && stop.distance + ZONE <= from + moved) {
      const time = timeAt(stop.distance + ZONE)
      if (entered?.stop === stop.index)
        crossings.push({ kind: "zone", stop: stop.id, arrive: entered.at, depart: time })
      left = { stop: stop.index, at: time }
      entered = undefined
    }
  }

  return { trace: { track, at, isStopped, isStill, entered, left } as Trace, crossings }
}
