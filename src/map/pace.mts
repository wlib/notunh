// How buses are running right now, learned from every bus's reports on top of what the model learned over weeks:
// each bus's own pace, how much slower or quicker than the model it has lately been driving, which drifts back to
// usual as it goes unseen, and the last time each stretch and stop took, which the next bus there is nudged toward.
// Where a bus should be now follows from that, rather than from its reported speed, and so does when it'll leave
// each stop ahead (chain.mts). What a bus did between two reports is read by crossings.mts, which the nightly
// extraction reads the same way

import type { Track } from "../geo/follow.mts"
import { type RouteLine, firstAhead, lapOf, stopAt } from "./shapes.mts"
import { type Trace, MIN_RATE, ZONE, cross, driven } from "./crossings.mts"
import { type Model, emptyModel, legMu, zoneEstimate } from "./model.mts"

// Longer is a layover or a bus out of service, not a stop
const MAX_ZONE_TIME = 300 // s
// Before anything's been learned
export const DEFAULT_RATE = 6 // m/s
const DEFAULT_WAIT = 8 // s at a stop, or held up somewhere else
export const DEFAULT_ZONE = 2 * ZONE / DEFAULT_RATE + DEFAULT_WAIT

// A bus's pace drifts back to usual over about PACE_MEMORY, and strays from it by about PACE_SIGMA, while a leg
// strays from what the bus's pace makes it by about LEG_SIGMA, all in log s; fitted on Oct 7 to 19, all three
// stable from one held-out day to the next
export const PACE_MEMORY = 3600 // s
const PACE_SIGMA = 0.064
export const LEG_SIGMA = 0.17
// Further off than this, a leg says nothing of the bus's pace
const MAX_EXCESS = 1
// How long the last bus's time for a stretch or stop outweighs what's expected, halving every this long
const NUDGE_HALF_LIFE = 600 // s

/** How much longer than expected a bus has lately taken to drive, in log terms, with its variance, as of an epoch second */
export type Pace = { mean: number, variance: number, at: number }

export const NO_PACE: Pace = { mean: 0, variance: PACE_SIGMA ** 2, at: -Infinity }

/** A bus's pace as of a later epoch second, drifted back toward usual */
export const drifted = ({ mean, variance, at }: Pace, now: number): Pace => {
  const decay = Math.exp(-Math.max(0, now - at) / PACE_MEMORY)
  return { mean: mean * decay, variance: variance * decay ** 2 + PACE_SIGMA ** 2 * (1 - decay ** 2), at: Math.max(at, now) }
}

/** A bus's pace having finished a leg some log s longer than expected at an epoch second: a Kalman filter's step */
export const paced = (pace: Pace, excess: number, at: number): Pace => {
  const { mean, variance } = drifted(pace, at)
  const gain = variance / (variance + LEG_SIGMA ** 2)
  return { mean: mean + gain * (Math.min(MAX_EXCESS, Math.max(-MAX_EXCESS, excess)) - mean), variance: (1 - gain) * variance, at }
}

/** Mean log s a leg some meters long between two stops is expected to take at an epoch second */
export const expectedMu = (model: Model, route: string, from: string, to: string, meters: number, at: number) =>
  legMu(model, route, from, to, meters, at) ?? Math.log(Math.max(1, meters) / DEFAULT_RATE)

/** How long something took, and when it ended, in epoch seconds */
export type Took = { seconds: number, at: number }

/** What the map has seen of how buses run, shared by them all: the model, and the last time each stretch and stop took */
export type Lately = {
  model: Model,
  /** The last drive from leaving one stop's zone to entering the next's, keyed "from>to" by stop id */
  drives: Map<string, Took>,
  /** The last time from entering a stop's zone to leaving it, by stop id */
  zones: Map<string, Took>
}

export const createLately = (model = emptyModel()): Lately =>
  ({ model, drives: new Map(), zones: new Map() })

const weight = (age: number, halfLife: number) =>
  0.5 ** (Math.max(0, age) / halfLife)

/** s something is expected to take, from its mean log s, nudged toward the last one */
const expected = (mu: number, last: Took | undefined, now: number) =>
  Math.exp(last ? mu + (Math.log(last.seconds) - mu) * weight(now - last.at, NUDGE_HALF_LIFE) : mu)

/**
 * Learns from a bus's new report: the stretches it drove and the zones it went through since its last one, which
 * tell its pace, and the stop it's at or last left
 * @returns the bus's trace as of the new report
 */
export const observe = (lately: Lately, previous: Trace | undefined, track: Track<RouteLine>, at: number, isStopped: boolean): Trace => {
  const { trace, crossings } = cross(previous, track, at, isStopped)
  const { line } = track
  // A bus put on another route starts afresh, as the nightly extraction has it
  const isSameRoute = previous?.track.line.route === line.route
  let [pace, seen] = isSameRoute ? [previous.pace, previous.seen] : []
  for (const crossing of crossings)
    if (crossing.kind === "drive") {
      const seconds = crossing.end - crossing.start
      lately.drives.set(`${crossing.from}>${crossing.to}`, { seconds, at: crossing.end })
      pace = paced(pace ?? NO_PACE, Math.log(seconds) - expectedMu(lately.model, line.route, crossing.from, crossing.to, crossing.meters, crossing.end), crossing.end)
    }
    else {
      seen = { stop: crossing.stop, arrive: crossing.arrive, depart: crossing.depart }
      if (crossing.depart - crossing.arrive <= MAX_ZONE_TIME)
        lately.zones.set(crossing.stop, { seconds: crossing.depart - crossing.arrive, at: crossing.depart })
    }
  if (trace.entered)
    seen = { stop: line.stops[trace.entered.stop].id, arrive: trace.entered.at }
  return { ...trace, pace, seen }
}

/**
 * Meters along its line a bus has likely reached some seconds after its last report: driving each stretch and
 * waiting at each stop as long as expected now, and at a stop where it waits for its scheduled time, until then
 */
export const expectedDistance = (lately: Lately, trace: Trace, seconds: number) => {
  const { line, distance } = trace.track
  // Reported stopped twice running, there's no telling when it'll go, so it stays put until it does
  if (!line.stops.length || trace.isStill)
    return distance

  const now = trace.at + seconds
  const bias = drifted(trace.pace ?? NO_PACE, now).mean
  const typical = DEFAULT_RATE / Math.exp(bias)
  const lap = lapOf(line, distance)
  const rateBetween = (i: number) => {
    if (!line.isLoop && (i <= 0 || i >= line.stops.length))
      return typical
    const [from, to] = [stopAt(line, lap, i - 1), stopAt(line, lap, i)]
    const meters = driven(from, to)
    if (meters <= 0)
      return typical
    const drive = expected(expectedMu(lately.model, line.route, from.id, to.id, meters, now) + bias, lately.drives.get(`${from.id}>${to.id}`), now)
    return Math.max(MIN_RATE, meters / drive)
  }
  const zoneTime = (id: string) =>
    expected(Math.log(zoneEstimate(lately.model, line.route, id, false)?.mean || DEFAULT_ZONE), lately.zones.get(id), now)
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
