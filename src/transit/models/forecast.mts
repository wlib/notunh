// Forecasting: when each bus will be at each stop, and how sure that is.
// - A bus the map is following is forecast along its course from where the location model has it (movement.mts),
//   on into the next loop where its trip ends where another starts. That one course is its runs' times and where the
//   map draws it
// - A route that keeps to its timetable is forecast from that, shifted by how late the route runs, once it's far
//   enough ahead (HANDOFF) that breaks and holds put the bus back on it
// - A run with no bus followed is its timetable, shifted likewise
//
// A live source's word comes in as a Forecast (predictions.mts), so the planner never reads a provider's shape
// itself. It says which bus runs which trip and which runs aren't coming, and stands in for the model on a bus it
// has on a trip the map isn't following. What the model has learned replaces the constants below wherever it has
// data

import { type Feed, type Trip, arrivalTime, isServiceActive, serviceDayStart } from "../feed.mts"
import { distance } from "../../geo/projection.mts"
import { type Forecast, NO_FORECAST } from "../observations/predictions.mts"
import { lineOf, positionsOf } from "../shapes.mts"
import { type Estimate, type Model, dayType, emptyModel } from "./model.mts"
import { bandScale, holdChances, isLikely, offsetEstimate } from "./estimates.mts"
import { probit } from "../../shared/normal.mts"
import { type Pace, type Trajectory, type Waypoint, type Whereabouts, course } from "./movement.mts"
import { type Day, addDays } from "../../shared/time.mts"
import { groupBy } from "../../shared/group.mts"

/**
 * The version of forecasting, bumped with any change to what it forecasts from a model and what's seen, so the bands
 * are calibrated afresh by evaluations of what it forecasts now (fit.mts)
 */
export const FORECAST = 1

// How far off a predicted departure may be, growing with how far ahead it is, until the model knows better. Live
// predictions were seen off by up to a minute or two, and Umo's guesses for a connector's next loop by far more
const UNCERTAINTY_NOW = 60           // s, even for a bus due now
const UNCERTAINTY_RATE = 5           // s more per minute ahead
const UNCERTAINTY_MAX = 240          // s
const SCHEDULE_FACTOR = 2            // a time from the timetable, with no bus tracked, is this much more uncertain
export const BOARDING = 30           // s, to get on a bus waiting at the stop for its scheduled time
// How sure the slack before a bus should be that it hasn't left yet
const SURE_P = 0.85
// A route that keeps to its timetable, as those with timepoints do, is back on it this far ahead and more. Held out,
// its timetable shifted by how late it runs beat chaining a bus there by 130 to 270 s at 30 and 60 minutes ahead.
// That can put a stop past it sooner than the one before, as can a source's uneven predictions. A run's times are
// left so rather than put in order, as forcing them in order lost at short leads about what it gained at 30
// minutes. The planner's connections are put in order (plan.mts)
const HANDOFF = 1800 // s
// A loop's bus goes on into a next loop of its route only if that's due to start at most this much after the bus
// could, or this much before, for a bus running late. Replayed, going on into whichever loop is due nearest did no
// better
const CONTINUITY = { after: 1800, before: 3600 } // s

/** A trip running on a specific service day */
export type Run = {
  trip: Trip,
  /** Epoch seconds that the trip's times are relative to */
  base: number,
  /**
   * Epoch seconds the bus gets to and leaves each stop, aligned with trip.stops. For a bus the map is following
   * they're its course's up to HANDOFF, so in order there. Past it, and from a live source, they may not be
   */
  arrivals:   number[],
  departures: number[],
  /** How likely the bus is to wait at each stop for its scheduled time when it's early */
  holdChance: number[],
  /**
   * For a bus the map is following on this run, its course, the s² its departure from each stop varies by, and how many
   * standard deviations a forecast some seconds ahead is off by at most with a probability, as the model's turned out
   */
  tracked?: { trajectory: Trajectory, variances: number[], scale: (lead: number, p: number) => number },
  /** How late its route leaves its stops, and how much that varies, as the model has it */
  offset?: Estimate,
  /** A bus is on this trip, rather than it being forecast from the timetable */
  isLive: boolean,
  /** The bus expected to run this trip */
  vehicle?: string
}

/**
 * A bus the map is following, as of its last report in epoch seconds: the trip it's tagged with, the stop it's at
 * or last left, when it got there and left, and how far it's got toward the next, and how it's been driving
 */
export type Sighting = Whereabouts & { vehicleId: string, tripId: string, stop: string, pace: Pace, at: number }

/** Seconds a run leaves a stop after its scheduled time */
export const lateness = (run: Run, position: number) =>
  run.departures[position] - (run.base + run.trip.times[position])

/** A run at a stop on its timetable's times, some seconds late */
const scheduled = (run: Run, position: number, late: number) => {
  run.arrivals[position] = run.base + arrivalTime(run.trip, position) + late
  run.departures[position] = run.base + run.trip.times[position] + late
}

/** How far off a time `lead` seconds ahead may be */
export const uncertainty = (lead: number) =>
  Math.min(UNCERTAINTY_MAX, UNCERTAINTY_NOW + UNCERTAINTY_RATE * Math.max(0, lead) / 60)

/**
 * How far off a bus's time at a stop may be with probability p, early when boarding or late when getting off. For a
 * bus the map is following, it's the chain's spread, scaled to how far off its forecasts turn out. With no bus
 * tracked, it's how much its route's lateness varies. With nothing learned, it's a fixed spread growing with the
 * lead, wider for boarding by a time from the timetable alone
 */
const spreadTo = (run: Run, position: number, time: number, now: number, isBoarding: boolean, p: number) => {
  const { tracked, offset } = run
  if (tracked)
    return Math.min(UNCERTAINTY_MAX, Math.max(BOARDING, Math.sqrt(tracked.variances[position]) * tracked.scale(time - now, 2 * p - 1)))
  const z = probit(p)
  if (offset && !run.isLive)
    return Math.min(UNCERTAINTY_MAX * (isBoarding ? SCHEDULE_FACTOR : 1), Math.max(BOARDING, z * Math.sqrt(offset.variance)))
  return uncertainty(time - now) * (isBoarding && !run.isLive ? SCHEDULE_FACTOR : 1) * (z / probit(SURE_P))
}

/** How much later than expected a bus may get to a stop, for counting on catching another after it */
export const spread = (run: Run, position: number, time: number, now: number) =>
  spreadTo(run, position, time, now, false, SURE_P)

/**
 * How early to be at a stop for a bus leaving it at `departure`: an early bus waits there for its scheduled time
 * as likely as the model says, and the slack covers enough of the rest of the ways it might leave that, waits and
 * all, it's caught SURE_P of the time
 */
export const slack = (run: Run, position: number, departure: number, now: number) => {
  const waits = lateness(run, position) <= 0 ? run.holdChance[position] : 0
  if (waits >= SURE_P)
    return BOARDING
  return Math.max(BOARDING, spreadTo(run, position, departure, now, true, (SURE_P - waits) / (1 - waits)))
}

/**
 * The trip a bus is on or about to start: the one the source tags it with, nearest now, else of those the forecast
 * has it running, the one ending soonest
 */
export const runOf = (runs: Run[], { id, tripTag }: { id: string, tripTag?: string | null }, now: number) => {
  const end = (run: Run) => run.departures.at(-1)!
  const offset = (run: Run) => Math.max(0, run.departures[0] - now, now - end(run))
  return (
    runs.filter(run => run.trip.id === tripTag).sort((a, b) => offset(a) - offset(b))[0] ??
    runs.filter(run => run.vehicle === id && end(run) >= now).sort((a, b) => end(a) - end(b))[0]
  ) as Run | undefined
}

/**
 * The run of a trip, and the position on it, that a bus at a stop at an epoch second is at: the same trip runs on
 * several service days, and loops visit a stop twice, so the scheduled visit closest in time, unless a bus is seen at
 * the stop its trip starts from, where it's starting it, as the trip it's tagged with is the one it's leaving on
 */
const placed = (feed: Feed, runsByTripId: ReadonlyMap<string, Run[]>, tripId: string, stopId: string, time: number, isSeen = false) => {
  let best: { run: Run, position: number, offset: number } | undefined
  for (const run of runsByTripId.get(tripId) ?? []) {
    const isStart = isSeen && feed.stops[run.trip.stops[0]].id === stopId
    run.trip.stops.forEach((stop, position) => {
      const offset = Math.abs(run.base + run.trip.times[position] - time)
      if (feed.stops[stop].id === stopId && (!isStart || position === 0) && offset < (best?.offset ?? Infinity))
        best = { run, position, offset }
    })
  }
  return best
}

/**
 * Notes which bus each observed run is, and whether it's on it. For a bus on it, or for any run of a route the model
 * knows nothing of, shifts its times by its delays, carried forward from the latest observation before each stop. An
 * early bus holds for its scheduled time where it likely waits, up to where a route that keeps to its timetable is
 * back on it. A source's guess at when a bus will start a run, from its own schedule, is no better than the model's
 * timetable shifted by how late the route runs, so it says only which bus will
 * @returns the runs observed
 */
const applyObservations = (feed: Feed, { observations, at }: Forecast, runsByTripId: ReadonlyMap<string, Run[]>) => {
  const known = new Map<Run, Map<number, number>>()
  for (const observation of observations) {
    const found = placed(feed, runsByTripId, observation.tripId, observation.stopId, observation.time)
    if (!found)
      continue
    const { run, position } = found
    const delays = known.get(run) ?? new Map()
    delays.set(position, observation.time - (run.base + run.trip.times[position]))
    known.set(run, delays)
    run.vehicle = observation.vehicleId
    if (observation.isLive)
      run.isLive = true
  }

  // Each stop's delay is the latest prediction before it, pushed later by every stop the bus likely waited at so far.
  // An early bus holds there for its scheduled time, and what's predicted after it runs that much later
  for (const [run, delays] of known) {
    if (run.offset && !run.isLive)
      continue
    let delay = delays.get(Math.min(...delays.keys()))!
    let held = 0
    for (let position = 0; position < run.departures.length; position++) {
      delay = delays.get(position) ?? delay
      const late = delay + held
      const hold = isLikely(run.holdChance[position]) ? Math.max(0, -late) : 0
      held += hold
      scheduled(run, position, late)
      run.departures[position] += hold
      if (run.offset && run.trip.timepoints.length && run.departures[position] - at >= HANDOFF)
        scheduled(run, position, run.offset.mean)
    }
  }
  return new Set(known.keys())
}

/**
 * Meters a trip's bus drives from one stop to the next, along its shape, else guessed from the straight line, as
 * streets wind about a quarter more
 */
const metersTo = (feed: Feed, trip: Trip, position: number) => {
  const along = positionsOf(feed, trip)
  const driven = along && along[position] - along[position - 1]
  return driven && driven > 0 ? driven : distance(feed.stops[trip.stops[position - 1]], feed.stops[trip.stops[position]]) * 1.25
}

/**
 * Chains each bus the map is following from where it was seen along its run, up to where a route that keeps to its
 * timetable is back on it, waiting for their scheduled times at the stops between its trips' ends where they likely
 * wait. The ends are left out: on a loop they're one stop, and waiting there is a layover. Where the run ends at the
 * start of a later one of its route's the same service day, the chain lays over and goes on into the one due to start
 * there nearest when the bus would, if it's due about then (CONTINUITY). Only the run a bus is seen on is live. The
 * one after is only what it's expected to run
 * @returns the runs chained
 */
const applySightings = (feed: Feed, model: Model, sightings: readonly Sighting[], runs: readonly Run[], runsByTripId: ReadonlyMap<string, Run[]>) => {
  const tracked = new Set<Run>()
  const scale = (lead: number, p: number) => bandScale(model, lead, p)
  // Each run is the bus's that's seen on it, and of two tagged with it, the one nearer its time: the other is on a
  // loop after it, still tagged with it
  const seen = new Map<Run, { sighting: Sighting, position: number, offset: number }>()
  for (const sighting of sightings) {
    const found = placed(feed, runsByTripId, sighting.tripId, sighting.stop, sighting.depart ?? sighting.arrive, true)
    if (found && found.offset < (seen.get(found.run)?.offset ?? Infinity))
      seen.set(found.run, { sighting, ...found })
  }
  for (const [run, { sighting, position }] of seen) {
    const { trip } = run
    const end = trip.stops.length - 1
    const waypoint = ({ trip, base, holdChance }: Run, position: number): Waypoint => ({
      stop:    feed.stops[trip.stops[position]].id,
      route:   trip.route,
      isFirst: position === 0,
      meters:  position ? metersTo(feed, trip, position) : 0,
      ...position > 0 && position < trip.stops.length - 1 && isLikely(holdChance[position]) && { hold: base + trip.times[position] }
    })
    const along = (run: Run, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => waypoint(run, from + i))
    // Its way to the end of its run, where it lays over if another starts there
    const own = along(run, position, end)
    const layover = { ...own.at(-1)!, isFirst: true }
    const ended = sighting.depart === undefined || position < end
      ? course(model, [...own.slice(0, -1), layover], sighting, sighting.pace, sighting.at).departures.at(-1)!
      : -Infinity
    // The one the source has it starting next, else the one due to start nearest when it would
    const isNext = (other: Run) => +(other.vehicle === sighting.vehicleId)
    const gap = (other: Run) => Math.abs(other.departures[0] - ended)
    const isDue = (other: Run) => -CONTINUITY.before <= other.departures[0] - ended && other.departures[0] - ended <= CONTINUITY.after
    const next = runs
      .filter(other =>
        other.base === run.base && other.trip.times[0] > trip.times[0] && other.trip.route === trip.route && other.trip.stops[0] === trip.stops[end] && isDue(other) &&
        !seen.has(other) && !tracked.has(other) && !other.isLive
      )
      .sort((a, b) => isNext(b) - isNext(a) || gap(a) - gap(b))[0]
    const way = next ? [...own.slice(0, -1), layover, ...along(next, 1, next.trip.stops.length - 1)] : own
    const chained = course(model, way, sighting, sighting.pace, sighting.at)
    const trajectory: Trajectory = { course: chained, line: lineOf(feed, trip), from: positionsOf(feed, trip)?.[position] ?? 0 }
    const isTimed = trip.timepoints.length > 0

    // Each run's times from the chain, from a waypoint on, past which a route that keeps to its timetable is back on
    // it, even where the chain had it later at the stop before
    const fill = (target: Run, from: number, to: number, first: number) => {
      for (let i = from; i <= to; i++) {
        const k = first + i - from
        if (isTimed && chained.departures[k] - sighting.at >= HANDOFF)
          scheduled(target, i, target.offset?.mean ?? 0)
        else
          [target.arrivals[i], target.departures[i]] = [chained.arrivals[k], chained.departures[k]]
      }
      target.tracked = { trajectory, variances: target.trip.stops.map((_, i) => chained.variances[first + Math.max(0, i - from)]), scale }
      target.vehicle = sighting.vehicleId
      tracked.add(target)
    }
    fill(run, position, end, 0)
    run.isLive = true
    // It had been everywhere before by when it was seen, and ends its run where it gets in, if it lays over after
    const late = lateness(run, position)
    const seenAt = sighting.depart ?? sighting.arrive
    for (let i = 0; i < position; i++)
      scheduled(run, i, Math.min(late, seenAt - (run.base + trip.times[i])))
    if (next) {
      run.departures[end] = run.arrivals[end]
      fill(next, 0, next.trip.stops.length - 1, end - position)
    }
  }
  return tracked
}

/** Every trip running yesterday (past midnight), today, or tomorrow (late night planning), as forecast */
export const buildRuns = (feed: Feed, today: Day, forecast = NO_FORECAST, model = EMPTY, sightings: readonly Sighting[] = []) => {
  const runs: Run[] = []
  for (const day of [addDays(today, -1), today, addDays(today, 1)]) {
    const base = serviceDayStart(day) / 1000
    for (const trip of feed.trips)
      if (isServiceActive(feed.services[trip.service], day)) {
        const offset = offsetEstimate(model, trip.route, dayType(day))
        const late = offset?.mean ?? 0
        runs.push({
          trip,
          base,
          arrivals:   trip.stops.map((_, position) => base + arrivalTime(trip, position) + late),
          departures: trip.times.map(time => base + time + late),
          holdChance: holdChances(model, feed, trip),
          offset,
          isLive: false
        })
      }
  }

  const runsByTripId = groupBy(runs, run => run.trip.id)
  const observed = applyObservations(feed, forecast, runsByTripId)
  const tracked = applySightings(feed, model, sightings, runs, runsByTripId)

  // Due at a stop between the source's answer and as far as it looked there, a run it doesn't mention was missed,
  // unless it may be running late enough to be past where it looked
  const { at, coverage } = forecast
  const isMissed = (run: Run) => run.trip.stops.some((stop, position) => {
    const time = run.departures[position]
    return at <= time && time <= (coverage.get(run.trip.route)?.get(feed.stops[stop].id) ?? -Infinity) - spread(run, position, time, at)
  })
  return runs.filter(run => observed.has(run) || tracked.has(run) || !isMissed(run))
}

const EMPTY = emptyModel()
