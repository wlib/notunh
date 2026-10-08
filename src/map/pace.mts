// How buses are running right now, learned from every bus's reports on top of what the model learned over weeks:
// each stretch between stops and each stop takes as long as the model expects at this time of day, scaled by how
// much slower or quicker buses on that line have been lately, and nudged toward what the last bus there took.
// Where a bus should be now follows from that, rather than from its reported speed

import type { Line, Track } from "./geometry.mts"
import { contextAt, dayTypeOf, driveEstimate, dwellEstimate, type Estimate, type Model } from "./model.mts"

/** m around a stop where a bus is at it, pulling in, waiting, or pulling out */
export const ZONE = 25
// Longer is a layover or a bus out of service, not a stop
const MAX_ZONE_TIME = 300 // s
// Implausible paces, from a bus that parked or a snap onto the wrong line
const MIN_RATE = 0.5      // m/s
const MAX_RATE = 30       // m/s
// Further than this between reports, it's not the same trip
const MAX_JUMP = 2000     // m
// Longer than this between reports, there's no telling what it did in between, and moving, it could have stopped
// anywhere on the way: moving buses report every 11 s or so, and stopped ones every 30
const MAX_GAP = 120       // s
const MAX_STEP = 45       // s
// GPS wanders this far back along the street while a bus sits still
const JITTER = 30         // m
// Before anything's been learned
export const DEFAULT_RATE = 6 // m/s
export const DEFAULT_WAIT = 8 // s at a stop, or held up somewhere else
// Slower is idling at a stop, with a meaningless heading
export const MIN_MOVING_KPH = 3

// How long the evidence of how a line is running lasts: weighed by half every FACTOR_HALF_LIFE, gone after
// FACTOR_WINDOW, and worth as much as FACTOR_PRIOR drives that went exactly as expected
const FACTOR_HALF_LIFE = 900     // s
export const FACTOR_WINDOW = 2700 // s
const FACTOR_PRIOR = 3
// How long the last bus's time for a stretch or stop outweighs the rest, halving every this long
const NUDGE_HALF_LIFE = 600       // s

/** What the model expects of a stretch or stop, by stop ids, at an epoch second */
export type Prior = {
  drive: (route: string | undefined, from: string, to: string, meters: number, at: number) => Estimate | undefined,
  zone:  (stop: string, at: number) => Estimate | undefined
}

const NO_PRIOR: Prior = { drive: () => undefined, zone: () => undefined }

export const learnedPrior = (model: Model): Prior => ({
  drive: (route, from, to, meters, at) => driveEstimate(model, route, `${from}>${to}`, meters, contextAt(at)),
  zone:  (stop, at) => dwellEstimate(model, stop, dayTypeOf(contextAt(at)))
})

/** How long something took, and how much longer than expected in log terms */
export type Seen = {
  seconds: number,
  /** Epoch seconds it ended */
  at:      number,
  excess:  number
}

export type Pace = {
  prior: Prior,
  /** The last drive from leaving one stop's zone to entering the next's, keyed "from>to" by stop id */
  drives: Map<string, Seen>,
  /** The last time from entering a stop's zone to leaving it, by stop id */
  zones: Map<string, Seen>,
  /** Every line's recent drives and zones, the evidence for how it's running */
  recent: WeakMap<Line, { drives: Seen[], zones: Seen[] }>
}

export const createPace = (prior = NO_PRIOR): Pace =>
  ({ prior, drives: new Map(), zones: new Map(), recent: new WeakMap() })

/** One bus's last report, and what it was last seen doing at stops */
export type Trace = {
  track: Track,
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

/** A stop on a line, counting on around a loop: index n is the first stop on the second lap */
const stopAt = ({ stops, length, isLoop }: Line, lap: number, index: number) => {
  const n = stops.length
  const wrapped = ((index % n) + n) % n
  return {
    index: wrapped,
    id: stops[wrapped].id,
    distance: stops[wrapped].distance + (isLoop ? (lap + Math.floor(index / n)) * length : 0)
  }
}

const lapOf = ({ length, isLoop }: Line, distance: number) =>
  isLoop ? Math.floor(distance / length) : 0

/** The index of the first stop past a distance, which is the stop count past the end of a line that isn't a loop */
const firstAhead = (line: Line, distance: number) => {
  const offset = distance - lapOf(line, distance) * (line.isLoop ? line.length : 0)
  const i = line.stops.findIndex(stop => stop.distance > offset)
  return i === -1 ? line.stops.length : i
}

/** m driven between the zones of two stops some distance apart */
const driven = (from: { distance: number }, to: { distance: number }) =>
  to.distance - from.distance - 2 * ZONE

/**
 * The zone edges a bus crossed since its last report, timed by interpolating between the two reports
 * @returns its trace as of the new report, and the drives and stops it finished in between, in order
 */
export const cross = (previous: Trace | undefined, track: Track, at: number, isStopped: boolean) => {
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

// log s of a stop's zone, with nothing better to go on
const ZONE_MU = Math.log(2 * ZONE / DEFAULT_RATE + DEFAULT_WAIT)

const driveMu = (pace: Pace, line: Line, from: string, to: string, meters: number, at: number) =>
  pace.prior.drive(line.route, from, to, meters, at)?.mu ?? Math.log(Math.max(1, meters) / DEFAULT_RATE)

const zoneMu = (pace: Pace, stop: string, at: number) =>
  pace.prior.zone(stop, at)?.mu ?? ZONE_MU

const weight = (age: number, halfLife: number) =>
  0.5 ** (Math.max(0, age) / halfLife)

/** How much slower than expected things have lately been, in log terms, shrunk toward as expected */
export const factorOf = (seen: readonly Seen[], now: number) => {
  let [sum, total] = [0, FACTOR_PRIOR]
  for (const { excess, at } of seen)
    if (now - at <= FACTOR_WINDOW) {
      const w = weight(now - at, FACTOR_HALF_LIFE)
      sum += w * excess
      total += w
    }
  return sum / total
}

/** s something is expected to take: as the model has it, scaled by how the line's running, and nudged toward the last one */
const expected = (mu: number, factor: number, last: Seen | undefined, now: number) => {
  const usual = mu + factor
  return Math.exp(last ? usual + (Math.log(last.seconds) - usual) * weight(now - last.at, NUDGE_HALF_LIFE) : usual)
}

const remember = (seen: Seen[], next: Seen) =>
  [...seen.filter(old => next.at - old.at <= FACTOR_WINDOW), next]

/**
 * Learns from a bus's new report: the zones it entered and left since its last one
 * @returns the bus's trace as of the new report
 */
export const observe = (pace: Pace, previous: Trace | undefined, track: Track, at: number, isStopped: boolean): Trace => {
  const { trace, crossings } = cross(previous, track, at, isStopped)
  const { line } = track
  let recent = pace.recent.get(line)
  if (!recent)
    pace.recent.set(line, recent = { drives: [], zones: [] })
  for (const crossing of crossings)
    if (crossing.kind === "drive") {
      const seconds = crossing.end - crossing.start
      const mu = driveMu(pace, line, crossing.from, crossing.to, crossing.meters, crossing.start)
      const seen = { seconds, at: crossing.end, excess: Math.log(seconds) - mu }
      pace.drives.set(`${crossing.from}>${crossing.to}`, seen)
      recent.drives = remember(recent.drives, seen)
    }
    else if (crossing.depart - crossing.arrive <= MAX_ZONE_TIME) {
      const seconds = crossing.depart - crossing.arrive
      const seen = { seconds, at: crossing.depart, excess: Math.log(seconds) - zoneMu(pace, crossing.stop, crossing.arrive) }
      pace.zones.set(crossing.stop, seen)
      recent.zones = remember(recent.zones, seen)
    }
  return trace
}

/**
 * Meters along its line a bus has likely reached some seconds after its last report: driving each stretch and
 * waiting at each stop as long as expected now, and at a stop where it waits for its scheduled time, until then
 */
export const expectedDistance = (pace: Pace, trace: Trace, seconds: number) => {
  const { line, distance } = trace.track
  // Reported stopped twice running, there's no telling when it'll go, so it stays put until it does
  if (!line.stops.length || trace.isStill)
    return distance

  const now = trace.at + seconds
  const recent = pace.recent.get(line)
  const [driveFactor, zoneFactor] = [factorOf(recent?.drives ?? [], now), factorOf(recent?.zones ?? [], now)]
  const typical = DEFAULT_RATE / Math.exp(driveFactor)
  const lap = lapOf(line, distance)
  const rateBetween = (i: number) => {
    if (!line.isLoop && (i <= 0 || i >= line.stops.length))
      return typical
    const [from, to] = [stopAt(line, lap, i - 1), stopAt(line, lap, i)]
    const meters = driven(from, to)
    if (meters <= 0)
      return typical
    const drive = expected(driveMu(pace, line, from.id, to.id, meters, now), driveFactor, pace.drives.get(`${from.id}>${to.id}`), now)
    return Math.max(MIN_RATE, meters / drive)
  }
  const zoneTime = (id: string) =>
    expected(zoneMu(pace, id, now), zoneFactor, pace.zones.get(id), now)
  // Waiting at a stop is its time in the zone, less pulling in and out, and for a bus that holds there, at least
  // until its scheduled time, having got there `elapsed` seconds after its report
  const waitAt = (i: number, rateIn: number, rateOut: number, elapsed: number) => {
    const { id } = stopAt(line, lap, i)
    const hold = trace.holds?.get(id) ?? -Infinity
    return Math.max(0, zoneTime(id) - ZONE / rateIn - ZONE / rateOut, hold - (trace.at + elapsed))
  }

  let i = firstAhead(line, distance)
  let d = distance
  let t = seconds

  const behind = i > 0 || line.isLoop ? stopAt(line, lap, i - 1) : undefined
  const ahead = i < line.stops.length || line.isLoop ? stopAt(line, lap, i) : undefined
  const at = trace.entered && [behind, ahead].find(stop => stop?.index === trace.entered!.stop)

  if (at) {
    // Partway through a stop, with however long it spends there left
    const index = at === behind ? i - 1 : i
    const [rateIn, rateOut] = [rateBetween(index), rateBetween(index + 1)]
    const hold = trace.holds?.get(at.id) ?? -Infinity
    const remaining = Math.max(0, zoneTime(at.id) - (trace.at - trace.entered!.at), hold + ZONE / rateOut - trace.at)
    if (at === ahead) {
      const reach = (at.distance - d) / rateIn
      if (t <= reach)
        return d + rateIn * t
      d = at.distance
      t -= reach + Math.max(0, remaining - reach - ZONE / rateOut)
      i++
    }
    else
      t -= Math.max(0, remaining - (at.distance + ZONE - d) / rateOut)
  }
  else if (trace.isStopped)
    // Held up between stops, at a light or behind traffic
    t -= DEFAULT_WAIT

  while (t > 0) {
    if (!line.isLoop && i >= line.stops.length)
      return Math.min(line.length, d + typical * t)

    const next = stopAt(line, lap, i)
    const rate = rateBetween(i)
    const reach = (next.distance - d) / rate
    if (t <= reach)
      return d + rate * t
    d = next.distance
    t -= reach + waitAt(i, rate, rateBetween(i + 1), seconds - t + reach)
    i++
  }
  return d
}
