// How a bus is expected to move on from where it is, as one course. Each leg between stops takes as long as the
// model expects at this time of day, scaled by how much slower or quicker this bus has lately been driving (its
// pace). Its time along the leg is spent as buses' is: slower pulling out and in, and wherever the leg holds them
// up. Each stop takes as long as buses spend there, or until its scheduled time where the bus waits for that.
//
// A bus's course is built once, by forecasting (forecast.mts) along its trip, and read for when it gets to and leaves
// each stop ahead and for where it is at any moment, which is where the map draws it (src/map/render/buses.mts). A
// bus on no trip the timetable has is drawn along its line instead (courseAlong), with nothing to wait for. Where the
// bus is comes from the location model (locate.mts), and its pace from the legs that model has seen it drive

import type { Model } from "./model.mts"
import { legMu, lingerEstimate, profileEstimate, zoneEstimate } from "./estimates.mts"
import type { Location } from "../inference/passages.mts"
import { type RouteLine, stopAhead, stopDistance, stopId } from "../shapes.mts"
import { meanResidual } from "../../shared/normal.mts"

// A bus's pace drifts back to usual over about PACE_MEMORY, and strays from it by about PACE_SIGMA. A leg strays
// from what the bus's pace makes it by about LEG_SIGMA. Sigmas are in log s. All three were fitted on Oct 7 to 19
// and stable from one held-out day to the next. Neither resetting the pace after a break or a long layover, nor a
// pace for each bus at each time of day, foretold legs any better
export const PACE_MEMORY = 3600 // s
const PACE_SIGMA = 0.064
export const LEG_SIGMA = 0.17
// A bound rather than an estimate: a leg further off than this in log s (2.7 times as long as expected or more, as
// 0.65 % are) counts as only this far off. A mixture weighing each leg as driven or held up instead lost 25 to 35 s
// at 20 and 30 minutes ahead on a slow day, whose long legs it took for hold-ups
const MAX_EXCESS = 1
// Before anything's been learned: how fast buses drive, how long they spend at a stop, and how much longer one
// already there stays
export const DEFAULT_RATE = 6 // m/s
const DEFAULT_DWELL = 10 // s
const DEFAULT_LINGER = 30 // s
// A bus seen halted between stops is halted, all told, a median HALT with a log spread of HALT_SPREAD, fitted on
// Oct 7 to 19. CURRENT_SPREAD is how sure what's left of a stay at a stop is, as a share of it
export const HALT = 24.5 // s
const HALT_SPREAD = 0.76
const CURRENT_SPREAD = 0.35
// How long a bus's speed now says more of where it'll be than the leg's usual pace does
const SPEED_MEMORY = 5 // s
// A bus reported slower than this, m/s, between stops is standing in traffic or at a light, whatever its heading
// and the location model's reading of it: GPS reports a residual 2 to 4 km/h from a bus that isn't moving. On Oct
// 15, 824 of the 1,310 fixes the course had got more than 50 m ahead of were such buses, drawn driving off while
// they stood. Held as halted since the first fix that reported it slow, they're paced as a halted bus is. One just
// out of a stop is held too: of those reported slow within 10 s of leaving one, a third had moved on by the next
// fix, against a seventh of the rest, so most are standing still
export const SLOW = 1.4 // m/s

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

/**
 * A stop on a bus's way: its route there, whether a trip starts there, so it lays over, the meters from the one
 * before, and the epoch second it waits there until, where it likely does
 */
export type Waypoint = { stop: string, route: string, isFirst: boolean, meters: number, hold?: number }

/**
 * Where a bus is on its way: at its first stop since it got there, or having left it, and how far it's got toward
 * the next, as a share of the meters between them, how fast it's going, in m/s, and since when it's been halted
 * between them, if it is
 */
export type Whereabouts = { arrive: number, depart?: number, progress?: number, speed?: number, halted?: number }

/**
 * A bus's expected course: when it gets to and leaves each stop of its way, in epoch seconds, how sure each departure
 * is, and where it is when. It's at each stop from its arrival to its departure: distanceAt is that stop's meters
 * throughout
 */
export type Course = {
  arrivals:   number[],
  departures: number[],
  /** s² each departure varies by */
  variances:  number[],
  /** Meters along the way from its first stop at an epoch second, before which it's where it was, and after, at its last */
  distanceAt: (at: number) => number
}

/** A course laid along a line, its first stop `from` meters along it, laps and all, or along no line the map has */
export type Trajectory = { course: Course, line: RouteLine | undefined, from: number }

/** How much of a leg's time a bus has taken to get some share of the way along it, by the leg's profile */
const timeShareOf = (profile: readonly number[], share: number) => {
  const times = [0, ...profile, 1]
  const i = Math.min(3, Math.floor(Math.max(0, Math.min(1, share)) * 4))
  return times[i] + (share * 4 - i) * (times[i + 1] - times[i])
}

/** How far along a leg, as a share of its meters, a bus has got by some share of its time */
const shareAlong = (profile: readonly number[], timeShare: number) => {
  const times = [0, ...profile, 1]
  let i = 0
  while (i < 3 && times[i + 1] < timeShare)
    i++
  return (i + (timeShare - times[i]) / Math.max(1e-9, times[i + 1] - times[i])) / 4
}

/** The course of a bus along a way from the stop it's at or last left, as of an epoch second */
export const course = (model: Model, way: readonly Waypoint[], where: Whereabouts, pace: Pace, now: number): Course => {
  const { mean: bias } = drifted(pace, now)
  // The line through time it's drawn along: when it's at each meter mark of the way from its first stop
  const [knots, marks] = [[now], [0]]
  const reach = (time: number, meters: number) => {
    knots.push(time)
    marks.push(meters)
  }

  const [first] = way
  let [time, variance, meters] = [now, 0, 0]
  const arrivals = [where.arrive]
  if (where.depart === undefined) {
    // What's left of its time at the stop, from how long it's been there
    const left = lingerEstimate(model, first.route, first.stop, first.isFirst, now - where.arrive) ?? DEFAULT_LINGER
    time = Math.max(now + left, first.hold ?? -Infinity)
    variance = (CURRENT_SPREAD * left) ** 2
    reach(time, 0)
  }
  const departures = [where.depart ?? time]
  const variances = [variance]
  for (let i = 1; i < way.length; i++) {
    const mu = expectedMu(model, way[i].route, way[i - 1].stop, way[i].stop, way[i].meters, now)
    const spread = Math.expm1(LEG_SIGMA ** 2) * Math.exp(2 * mu + LEG_SIGMA ** 2)
    const profile = profileEstimate(model, way[i].route, way[i - 1].stop, way[i].stop)
    // Its pace, which drifts back to usual the further on it is
    const took = Math.exp(mu + LEG_SIGMA ** 2 / 2) * Math.exp(bias * Math.exp(-(time - now) / PACE_MEMORY))
    if (i === 1 && where.depart !== undefined) {
      const partway = along(way[1].meters, took, profile, where, now)
      marks[0] = partway.from
      for (const [after, at] of partway.knots)
        reach(time + after, at)
      time += partway.took
      variance += spread * partway.left
    }
    else {
      for (let q = 1; q < 4; q++)
        reach(time + timeShareOf(profile, q / 4) * took, meters + q / 4 * way[i].meters)
      time += took
      variance += spread
    }
    meters += way[i].meters
    reach(time, meters)
    arrivals.push(time)
    // At the stop, as long as buses spend there, and at one it waits at, until its scheduled time
    const stop = zoneEstimate(model, way[i].route, way[i].stop, way[i].isFirst) ?? { mean: DEFAULT_DWELL, variance: 0 }
    time = Math.max(time + stop.mean, way[i].hold ?? -Infinity)
    variance += stop.variance
    reach(time, meters)
    departures.push(time)
    variances.push(variance)
  }

  const distanceAt = (at: number) => {
    if (at <= knots[0])
      return marks[0]
    let [low, high] = [0, knots.length - 1]
    if (at >= knots[high])
      return marks[high]
    while (high - low > 1) {
      const middle = (low + high) >> 1
      if (knots[middle] <= at)
        low = middle
      else
        high = middle
    }
    const span = knots[high] - knots[low]
    return marks[low] + (span > 0 ? (at - knots[low]) / span : 1) * (marks[high] - marks[low])
  }
  return { arrivals, departures, variances, distanceAt }
}

/**
 * The rest of a leg a bus is partway along, which its pace is already in, held up first if it's halted. It starts
 * from as far as it's seen to have got, or with nothing seen since it left, as far as the time since says, with some
 * always left. Where its speed is known, that says more of the next few seconds than the leg does, settling toward
 * the pace that gets it to the next stop when expected
 * @returns how far along it is, how long it takes from here, what share of the leg is left, and the knots of its
 * drive from here, as seconds from now and meters along the leg
 */
const along = (meters: number, took: number, profile: readonly number[], where: Whereabouts, now: number) => {
  const elapsed = Math.max(0, now - where.depart!)
  const share = where.progress === undefined
    ? elapsed / (elapsed + meanResidual(Math.log(took) - LEG_SIGMA ** 2 / 2, LEG_SIGMA, elapsed))
    : timeShareOf(profile, Math.max(0, Math.min(1, where.progress)))
  const progress = where.progress === undefined ? shareAlong(profile, share) : Math.max(0, Math.min(1, where.progress))
  // Halted, as long again as a bus halted that long is on average
  const held = where.halted === undefined ? 0 : meanResidual(Math.log(HALT), HALT_SPREAD, now - where.halted)
  const from = progress * meters
  const rest = took * (1 - share)
  if (where.speed === undefined)
    return {
      from, took: held + rest, left: 1 - share,
      knots: [1, 2, 3, 4].filter(q => q / 4 > progress).map(q =>
        [held + (timeShareOf(profile, q / 4) - share) / Math.max(1e-9, 1 - share) * rest, q / 4 * meters]
      )
    }
  const left = meters - from
  const usual = left / Math.max(1e-9, rest)
  const covered = (t: number) => usual * t + (where.speed! - usual) * SPEED_MEMORY * (1 - Math.exp(-t / SPEED_MEMORY))
  const reaching = (x: number) => {
    let [low, high] = [0, 4 * (rest + SPEED_MEMORY)]
    for (let k = 0; k < 40; k++) {
      const middle = (low + high) / 2
      if (covered(middle) < x)
        low = middle
      else
        high = middle
    }
    return high
  }
  return {
    from, took: held + reaching(left), left: 1 - share,
    knots: [[held, from], ...[1, 2, 3, 4].map(q => [held + reaching(q / 4 * left), from + q / 4 * left])]
  }
}

// Stops ahead that a bus's course on its line is drawn through, more than it gets through in the minute or so it's drawn on past a fix
const DRAWN_STOPS = 8

/**
 * Epoch seconds a bus has been reported slower than SLOW between stops since, given when it had been as of the fix
 * before, or undefined once it's at a stop or driving again
 */
export const slowSince = (location: Location, before: number | undefined) =>
  location.mode === "moving" && location.speed < SLOW ? before ?? location.at : undefined

/**
 * Where the location model has a bus on its way, from the stop it's at or last left, or followed since before any,
 * the stop behind it: that stop's index along its line, its meters along it, and the bus's whereabouts from there,
 * held as halted since it was first reported slow where it has been (slowSince)
 */
export const whereaboutsOf = (location: Location, slow?: number) => {
  const { line, last } = location
  const start = last?.index ?? stopAhead(line, location.distance) - 1
  const [from, to] = [stopDistance(line, start), stopDistance(line, start + 1)]
  const where: Whereabouts = location.mode === "dwelling"
    ? { arrive: location.since }
    : {
      arrive:   last?.arrive ?? location.since,
      depart:   last?.depart ?? location.since,
      progress: Number.isFinite(to - from) && to > from ? (location.distance - from) / (to - from) : 0,
      speed:    location.speed,
      ...location.mode === "halted"
        ? { halted: location.since }
        : slow !== undefined && { halted: slow }
    }
  return { start, from, where }
}

/**
 * A bus's course along its line from where the location model has it, through the next few stops, for drawing a bus
 * on no trip forecasting knows of, so with nowhere to wait for a scheduled time
 */
export const courseAlong = (model: Model, location: Location, pace: Pace, slow?: number): Trajectory | undefined => {
  const { line } = location
  const { start, from, where } = whereaboutsOf(location, slow)
  if (!Number.isFinite(from))
    return
  const way = Array.from({ length: DRAWN_STOPS + 1 }, (_, i): Waypoint | undefined => {
    const distance = stopDistance(line, start + i)
    if (!Number.isFinite(distance))
      return
    return {
      stop:    stopId(line, start + i),
      route:   line.route,
      isFirst: false,
      meters:  i ? distance - stopDistance(line, start + i - 1) : 0
    }
  }).filter(waypoint => waypoint !== undefined)
  return { course: course(model, way, where, pace, location.at), line, from }
}
