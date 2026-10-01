// How buses have been moving lately, learned from every bus's reports: how long the last bus took to drive
// between each pair of stops, and how long it spent at each stop. Where a bus should be now follows from that,
// rather than from its reported speed

import type { Line, Track } from "./geometry.mts"

/** m around a stop where a bus is at it, pulling in, waiting, or pulling out */
export const ZONE = 25
// Longer is a layover or a bus out of service, not a stop
const MAX_ZONE_TIME = 300 // s
// Implausible paces, from a bus that parked or a snap onto the wrong line
const MIN_RATE = 0.5      // m/s
const MAX_RATE = 30       // m/s
// Further than this between reports, it's not the same trip
const MAX_JUMP = 2000     // m
// Before anything's been learned
const DEFAULT_RATE = 6    // m/s
const DEFAULT_WAIT = 8    // s at a stop, or held up somewhere else

// Recent drives' m/s, for stretches nobody's driven yet
const RECENT_RATES = 50

export type Pace = {
  /** s from leaving one stop's zone to entering the next's, keyed "from>to" by stop id */
  drives: Map<string, number>,
  /** s from entering a stop's zone to leaving it, by stop id */
  zones: Map<string, number>,
  /** m/s of the latest drives, newest last */
  rates: number[]
}

export const createPace = (): Pace => ({ drives: new Map(), zones: new Map(), rates: [] })

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
  left?: { stop: number, at: number }
}

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

/**
 * Learns from a bus's new report: the zones it entered and left since its last one, timed by
 * interpolating between the two reports
 * @returns the bus's trace as of the new report
 */
export const observe = (pace: Pace, previous: Trace | undefined, track: Track, at: number, isStopped: boolean): Trace => {
  const { line } = track
  const isSameRun = previous?.track.line === line && at > previous.at
  const isStill = isStopped && previous?.isStopped
  if (!isSameRun || !line.stops.length)
    return { track, at, isStopped, isStill }

  const from = previous.track.distance
  const moved =
    line.isLoop
      ? ((track.distance - from) % line.length + line.length) % line.length
      : track.distance - from
  if (moved < 0 || moved > MAX_JUMP)
    return { track, at, isStopped, isStill }

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
        const rate = (stop.distance - previousStop.distance - 2 * ZONE) / (time - left.at)
        if (rate >= MIN_RATE && rate <= MAX_RATE) {
          pace.drives.set(`${previousStop.id}>${stop.id}`, time - left.at)
          pace.rates = [...pace.rates, rate].slice(-RECENT_RATES)
        }
      }
      entered = { stop: stop.index, at: time }
    }
    if (stop.distance + ZONE > from && stop.distance + ZONE <= from + moved) {
      const time = timeAt(stop.distance + ZONE)
      if (entered?.stop === stop.index && time - entered.at <= MAX_ZONE_TIME)
        pace.zones.set(stop.id, time - entered.at)
      left = { stop: stop.index, at: time }
      entered = undefined
    }
  }

  return { track, at, isStopped, isStill, entered, left }
}

const median = (values: Iterable<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[sorted.length >> 1] : undefined
}

/** m/s typical of recent drives */
const typicalRate = (pace: Pace) =>
  median(pace.rates) ?? DEFAULT_RATE

/**
 * Meters along its line a bus has likely reached some seconds after its last report:
 * driving each stretch at the pace the last bus did, and waiting at each stop as long as it did
 */
export const expectedDistance = (pace: Pace, trace: Trace, seconds: number) => {
  const { line, distance } = trace.track
  // Reported stopped twice running, there's no telling when it'll go, so it stays put until it does
  if (!line.stops.length || trace.isStill)
    return distance

  const typical = typicalRate(pace)
  const lap = lapOf(line, distance)
  const rateBetween = (i: number) => {
    if (!line.isLoop && (i <= 0 || i >= line.stops.length))
      return typical
    const [from, to] = [stopAt(line, lap, i - 1), stopAt(line, lap, i)]
    const drive = pace.drives.get(`${from.id}>${to.id}`)
    return drive ? Math.max(MIN_RATE, (to.distance - from.distance - 2 * ZONE) / drive) : typical
  }
  // Waiting at a stop is its time in the zone, less pulling in and out
  const waitAt = (i: number, rateIn: number, rateOut: number) => {
    const zone = pace.zones.get(stopAt(line, lap, i).id)
    return zone === undefined ? DEFAULT_WAIT : Math.max(0, zone - ZONE / rateIn - ZONE / rateOut)
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
    const remaining = Math.max(0, (pace.zones.get(at.id) ?? ZONE / rateIn + DEFAULT_WAIT + ZONE / rateOut) - (trace.at - trace.entered!.at))
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
    t -= reach + waitAt(i, rate, rateBetween(i + 1))
    i++
  }
  return d
}
