// Forecasting: when each bus will be at each stop, and how sure that is, from the timetable, what the model has
// learned, and what a live source says of the buses out now. A source's word comes in as observations, a time it
// gives for a trip at a stop, and how far ahead it covers each route at each stop (umo.mts makes these of Umo's
// predictions), so the planner never reads a provider's shape itself. What the model has learned replaces the
// constants below wherever it has data

import { type Feed, type Trip, arrivalTime, isServiceActive, serviceDayStart } from "./feed.mts"
import { distance } from "../geo/projection.mts"
import { STREET_DETOUR } from "./walks.mts"
import {
  type Estimate, type Model, context, dayType, deviationEstimate, driveEstimate, dwellEstimate, emptyModel, holdChances, inflation,
  isLikely, layoverEstimate, leadIndex, probit, variance, LEADS
} from "./model.mts"
import { type Day, addDays } from "../shared/time.mts"

// How far off a predicted departure may be, growing with how far ahead it is, until the model knows better. Live
// predictions were seen off by up to a minute or two, and Umo's guesses for a connector's next loop by far more
const UNCERTAINTY_NOW = 60           // s, even for a bus due now
const UNCERTAINTY_RATE = 5           // s more per minute ahead
const UNCERTAINTY_MAX = 240          // s
const SCHEDULE_FACTOR = 2            // a time from the timetable, with no bus tracked, is this much more uncertain
export const BOARDING = 30           // s, to get on a bus waiting at the stop for its scheduled time
// Connectors don't wait for their timetable at the end of a loop, only a couple of minutes, so a bus's next loop
// starts this long after it gets in, when that's sooner than Umo says
export const LAYOVER = 120           // s
// How sure the slack before a bus should be that it hasn't left yet
const SURE_P = 0.85
const SURE = probit(SURE_P)

/** A trip running on a specific service day */
export type Run = {
  trip: Trip,
  /** Epoch seconds that the trip's times are relative to */
  base: number,
  /** Seconds the bus leaves each stop later than scheduled, aligned with trip.stops */
  delays: number[],
  /** Seconds the bus is expected to wait at each stop for its scheduled time */
  holds: number[],
  /** How likely the bus is to wait at each stop for its scheduled time when it's early */
  holdChance: number[],
  /** What the model knows of how far off this run's times may be */
  spread?: Spread,
  /** A tracked bus is on this trip, rather than Umo predicting from its schedule */
  isLive: boolean,
  /** The bus Umo expects to run this trip */
  vehicle?: string
}

export type Spread = {
  /** s² that driving and stopping from its first stop up to leaving each one varies by, for routes with drives */
  variance?: number[],
  /** s the bus leaves each stop after its timetable, with no bus tracked, where the model knows */
  deviation: (Estimate | undefined)[],
  /** How many times wider than the variance says the forecasts in use turn out, at each of LEADS */
  inflation: number[]
}

/** A live source's word on a trip: when a bus is expected at a stop, from the bus itself or from the source's own schedule */
export type Observation = {
  tripId:    string,
  stopId:    string,
  /** Epoch seconds */
  time:      number,
  vehicleId: string,
  /** The bus is on this trip, rather than the source predicting from its schedule before it starts it */
  isLive:    boolean
}

/**
 * What a live source says of the buses out now: its observations, when it gave them, in epoch seconds, and up to
 * when it covers each route at each stop it answered for, by route id and then stop id, within which a run due
 * there that it doesn't mention isn't coming. A source covers only what it answered for, so a far look ahead at
 * one stop says nothing of another
 */
export type Forecast = { observations: Observation[], at: number, coverage: Map<string, Map<string, number>> }

export const NO_FORECAST: Forecast = { observations: [], at: -Infinity, coverage: new Map() }

/** When the bus leaves a stop */
export const timeAt = (run: Run, position: number) =>
  run.base + run.trip.times[position] + run.delays[position]

/** When the bus gets to a stop, which waiting there for its scheduled time doesn't put off */
export const arrivalAt = (run: Run, position: number) =>
  run.base + arrivalTime(run.trip, position) + run.delays[position] - run.holds[position]

/** How far off a time `lead` seconds ahead may be */
export const uncertainty = (lead: number) =>
  Math.min(UNCERTAINTY_MAX, UNCERTAINTY_NOW + UNCERTAINTY_RATE * Math.max(0, lead) / 60)

const currentCache = new WeakMap<Run, { now: number, position: number }>()

/** The first stop a run hasn't left yet */
const currentPosition = (run: Run, now: number) => {
  let current = currentCache.get(run)
  if (current?.now !== now) {
    const position = run.trip.stops.findIndex((_, position) => timeAt(run, position) >= now)
    currentCache.set(run, current = { now, position: position === -1 ? run.trip.stops.length - 1 : position })
  }
  return current.position
}

/**
 * How far off a bus's time at a stop may be, to `z` standard deviations: as the model says for a tracked bus, by how
 * much the stretch from where it is varies, scaled to how far off forecasts turn out, or otherwise by how early, when
 * boarding, or late, when getting off, it usually runs against its timetable; and with nothing learned, as it
 * always was, wider for a time from the timetable alone
 */
const spreadTo = (run: Run, position: number, time: number, now: number, isBoarding: boolean, z: number) => {
  const { spread } = run
  const deviation = spread?.deviation[position]
  if (deviation && !run.isLive)
    return isBoarding
      ? Math.min(UNCERTAINTY_MAX * SCHEDULE_FACTOR, Math.max(BOARDING, z * deviation.sigma - deviation.mu))
      : Math.min(UNCERTAINTY_MAX, Math.max(BOARDING, z * deviation.sigma + deviation.mu))
  if (spread?.variance && run.isLive) {
    const from = Math.min(position, currentPosition(run, now))
    const sd = Math.sqrt(Math.max(0, spread.variance[position] - spread.variance[from]))
    return Math.min(UNCERTAINTY_MAX, Math.max(BOARDING, z * sd * spread.inflation[leadIndex(time - now)]))
  }
  return uncertainty(time - now) * (isBoarding && !run.isLive ? SCHEDULE_FACTOR : 1) * (z / SURE)
}

/** How much later than expected a bus may get to a stop, for counting on catching another after it */
export const spread = (run: Run, position: number, time: number, now: number) =>
  spreadTo(run, position, time, now, false, SURE)

/**
 * How early to be at a stop for a bus leaving it at `departure`: an early bus waits there for its scheduled time
 * as likely as the model says, and the slack covers enough of the rest of the ways it might leave that, waits and
 * all, it's caught SURE_P of the time
 */
export const slack = (run: Run, position: number, departure: number, now: number) => {
  const waits = run.delays[position] <= 0 ? run.holdChance[position] : 0
  if (waits >= SURE_P)
    return BOARDING
  const z = probit((SURE_P - waits) / (1 - waits))
  return Math.max(BOARDING, spreadTo(run, position, departure, now, true, z))
}

/** How long between trips a route's buses lay over */
const layoverOf = (model: Model, route: string) => {
  const estimate = layoverEstimate(model, route)
  return estimate ? Math.exp(estimate.mu) : LAYOVER
}

/**
 * The trip a bus is on or about to start: the one the source tags it with, nearest now, else of those the forecast
 * has it running, the one ending soonest
 */
export const runOf = (runs: Run[], { id, tripTag }: { id: string, tripTag?: string | null }, now: number) => {
  const end = (run: Run) => timeAt(run, run.trip.stops.length - 1)
  const offset = (run: Run) => Math.max(0, timeAt(run, 0) - now, now - end(run))
  return (
    runs.filter(run => run.trip.id === tripTag).sort((a, b) => offset(a) - offset(b))[0] ??
    runs.filter(run => run.vehicle === id && end(run) >= now).sort((a, b) => end(a) - end(b))[0]
  ) as Run | undefined
}

/**
 * Shifts each observed trip's times by its delays, carried forward from the latest observation before each stop,
 * with an early bus holding at timepoints for its scheduled time. A connector's next loop starts a layover after
 * its bus gets in, when that's sooner than the source says.
 * @returns the runs the source has nothing to say about although it covers a stop of theirs when they're due
 * there, so they aren't coming (connectors run by headway, not to the timetable)
 */
const applyForecast = (feed: Feed, model: Model, { observations, at, coverage }: Forecast, runs: Run[]) => {
  const runsByTripId = new Map<string, Run[]>()
  for (const run of runs)
    runsByTripId.set(run.trip.id, [...runsByTripId.get(run.trip.id) ?? [], run])

  const known = new Map<Run, Map<number, number>>()

  for (const observation of observations) {
    // The same trip runs on several service days, and loops visit a stop twice,
    // so match the scheduled visit closest in time to the observation
    let run: Run | undefined
    let position = 0
    let bestOffset = Infinity
    for (const candidate of runsByTripId.get(observation.tripId) ?? [])
      candidate.trip.stops.forEach((stop, i) => {
        if (feed.stops[stop].id !== observation.stopId)
          return
        const offset = Math.abs(candidate.base + candidate.trip.times[i] - observation.time)
        if (offset < bestOffset) {
          bestOffset = offset
          run = candidate
          position = i
        }
      })
    if (!run)
      continue

    const delays = known.get(run) ?? new Map()
    delays.set(position, observation.time - (run.base + run.trip.times[position]))
    known.set(run, delays)
    run.vehicle = observation.vehicleId
    if (observation.isLive)
      run.isLive = true
  }

  // Each stop's delay is the latest prediction before it, pushed later by every timepoint the bus waited at so far:
  // an early bus holds there for its scheduled time, and what's predicted after it runs that much later
  for (const [run, delays] of known) {
    let delay = delays.get(Math.min(...delays.keys()))!
    let held = 0
    for (let position = 0; position < run.delays.length; position++) {
      delay = delays.get(position) ?? delay
      const hold = isLikely(run.holdChance[position]) ? Math.max(0, -(delay + held)) : 0
      held += hold
      run.holds[position] = hold
      run.delays[position] = delay + held
    }
  }

  // A bus's next loop, unless it waits for its scheduled start, begins a layover after the loop it's on ends
  for (const run of known.keys()) {
    if (run.isLive || isLikely(run.holdChance[0]))
      continue
    const start = timeAt(run, 0)
    const sameBus = [...known.keys()].filter(other => other.vehicle === run.vehicle)
    // Only the loop right after the one it's on, as the ones after that follow on from it
    if (sameBus.some(other => !other.isLive && timeAt(other, 0) < start))
      continue
    const end = Math.max(...sameBus.filter(other => other.isLive).map(other => timeAt(other, other.trip.stops.length - 1)))
    if (Number.isFinite(end) && end <= start)
      run.delays = run.delays.map(delay => delay + Math.min(0, end + layoverOf(model, run.trip.route) - start))
  }

  // Due at a stop between the source's answer and as far as it looked there, a run it doesn't mention was missed,
  // unless it may be running late enough to be past where it looked
  const isMissed = (run: Run) => run.trip.stops.some((stop, position) => {
    const time = timeAt(run, position)
    return at <= time && time <= (coverage.get(run.trip.route)?.get(feed.stops[stop].id) ?? -Infinity) - spread(run, position, time, at)
  })
  return new Set(runs.filter(run => !known.has(run) && isMissed(run)))
}

const spreadCache = new WeakMap<Model, WeakMap<Trip, Spread[]>>()

/** What the model knows of how far off a trip's times may be, on a weekday or a weekend */
const spreadOf = (feed: Feed, model: Model, trip: Trip, day: Day): Spread => {
  let byTrip = spreadCache.get(model)
  if (!byTrip)
    spreadCache.set(model, byTrip = new WeakMap())
  const spreads = byTrip.get(trip) ?? []
  byTrip.set(trip, spreads)
  const type = dayType(day)
  return spreads[type] ??= {
    variance: model.paces[trip.route] && trip.stops.reduce((sums, stop, position) => {
      if (position === 0)
        return [0]
      const [from, to] = [feed.stops[trip.stops[position - 1]], feed.stops[stop]]
      const drive = driveEstimate(model, trip.route, `${from.id}>${to.id}`, distance(from, to) * STREET_DETOUR, context(day, trip.times[position - 1]))
      const dwell = position < trip.stops.length - 1 ? dwellEstimate(model, to.id, type) : undefined
      return [...sums, sums.at(-1)! + (drive ? variance(drive) : 0) + (dwell ? variance(dwell) : 0)]
    }, [] as number[]),
    deviation: trip.stops.map(stop => deviationEstimate(model, trip.route, feed.stops[stop].id, type)),
    inflation: LEADS.map(minutes => inflation(model, minutes * 60))
  }
}

const EMPTY = emptyModel()

/** Every trip running yesterday (past midnight), today, or tomorrow (late night planning), as forecast */
export const buildRuns = (feed: Feed, today: Day, forecast = NO_FORECAST, model = EMPTY) => {
  const runs: Run[] = []
  for (const day of [addDays(today, -1), today, addDays(today, 1)]) {
    const base = serviceDayStart(day) / 1000
    for (const trip of feed.trips)
      if (isServiceActive(feed.services[trip.service], day))
        runs.push({
          trip,
          base,
          delays: trip.times.map(() => 0),
          holds:  trip.times.map(() => 0),
          holdChance: holdChances(model, feed, trip),
          spread: model.through ? spreadOf(feed, model, trip, day) : undefined,
          isLive: false
        })
  }

  const notComing = applyForecast(feed, model, forecast, runs)
  return runs.filter(run => !notComing.has(run))
}
