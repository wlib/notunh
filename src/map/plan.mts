// Trip planning with the Connection Scan Algorithm over the GTFS schedule,
// shifted by Umo's predictions (their trip ids match the GTFS trip ids)
// https://arxiv.org/abs/1703.05997
//
// Every boarding leaves slack for how unsure the bus's departure is, buses hold where they wait for their scheduled
// time, and nearer first stops are tried as well as whichever arrives first, so ranking can weigh walking against
// waiting. What the model has learned replaces the constants below wherever it has data

import { type Feed, type Trip, arrivalTime, canAlight, canBoard, isServiceActive, serviceDayStart } from "./feed.mts"
import { distance } from "../geo/projection.mts"
import { STREET_DETOUR, type Walks, walkAllowance, walkSeconds } from "./walks.mts"
import type { StopPredictions, Vehicle } from "./umo.mts"
import {
  type Estimate, type Model, context, dayType, deviationEstimate, driveEstimate, dwellEstimate, emptyModel, holdChances, inflation,
  isLikely, layoverEstimate, leadIndex, probit, variance, LEADS
} from "./model.mts"
import { type Day, addDays } from "../shared/time.mts"

export const HORIZON = 4 * 3600      // s, how far ahead to look for buses
export const ALTERNATIVES = 3
const DEPARTURES = 6                 // first buses considered, with and without changing buses
const NEARER_STOPS = 8               // first stops nearer than the quickest one's to try as well
export const MIN_TIME_SAVED = 120    // s, a bus has to feel this much better than walking now
export const MIN_TRANSFER_GAIN = 300 // s, changing buses has to arrive this much sooner than any option with fewer

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

// How long an itinerary feels, relative to riding
const WALK_RELUCTANCE = 2            // walking feels twice as long
const WAIT_AT_STOP = 1.5             // waiting at a stop feels longer than riding
const WAIT_AT_HOME = 0.5             // waiting before leaving feels half as long
const TRANSFER_PENALTY = 300         // s, the hassle of changing buses, on top of the wait

export type Place = {
  lat:  number,
  lon:  number,
  name: string,
  /** Where you are, moving with you */
  isYou?: true
}

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

export type WalkLeg = {
  kind:   "walk",
  from:   Place,
  to:     Place,
  start:  number,
  end:    number,
  meters: number
}

export type RideLeg = {
  kind:  "ride",
  run:   Run,
  /** Positions within run.trip.stops */
  fromPosition: number,
  toPosition:   number,
  start: number,
  end:   number
}

export type Leg = WalkLeg | RideLeg

export type Itinerary = {
  legs:  Leg[],
  start: number,
  end:   number
}

export type Connection = {
  run:       number,
  position:  number,
  from:      number,
  to:        number,
  departure: number,
  arrival:   number
}

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
 * The trip a bus is on or about to start: the one Umo tags it with, nearest now, else from Umo's predictions, of
 * those it's running, the one ending soonest
 */
export const runOf = (runs: Run[], { id, tripTag }: Pick<Vehicle, "id" | "tripTag">, now: number) => {
  const end = (run: Run) => timeAt(run, run.trip.stops.length - 1)
  const offset = (run: Run) => Math.max(0, timeAt(run, 0) - now, now - end(run))
  return (
    runs.filter(run => run.trip.id === tripTag).sort((a, b) => offset(a) - offset(b))[0] ??
    runs.filter(run => run.vehicle === id && end(run) >= now).sort((a, b) => end(a) - end(b))[0]
  ) as Run | undefined
}

/** Identifies a ride by its run and where it gets on and off */
const rideKey = (leg: RideLeg) =>
  `${leg.run.trip.id}@${leg.run.base}:${leg.fromPosition}-${leg.toPosition}`

/** Identifies an itinerary across replans, changing only when its trips or times to the minute do */
export const itineraryKey = (itinerary: Itinerary) =>
  itinerary.legs.map(leg => leg.kind === "ride" ? rideKey(leg) : "walk").join(" ") +
  ` ${Math.floor(itinerary.start / 60)}-${Math.floor(itinerary.end / 60)}`

/**
 * Whether two itineraries would show the same: the same key, each ride on the same run of the same timetable's trip,
 * as live, late, and held the same, and each walk between the same places. A newer timetable's trips are new objects,
 * so its itineraries never pass for the old ones
 */
export const isSameItinerary = (a: Itinerary, b: Itinerary) =>
  itineraryKey(a) === itineraryKey(b) &&
  a.legs.every((leg, i) => {
    const other = b.legs[i]
    if (leg.kind === "walk")
      return other.kind === "walk" && leg.from === other.from && leg.to === other.to
    if (other.kind === "walk")
      return false
    const positions = [leg.fromPosition, leg.toPosition]
    return (
      leg.run.trip === other.run.trip &&
      leg.run.isLive === other.run.isLive &&
      leg.run.vehicle === other.run.vehicle &&
      positions.every(position => leg.run.delays[position] === other.run.delays[position] && leg.run.holds[position] === other.run.holds[position])
    )
  })

/**
 * Identifies where an itinerary goes, changing only when its rides or the places it walks between do, and not as
 * where you are moves with you
 */
export const wayKey = (itinerary: Itinerary) =>
  itinerary.legs
    .map(leg =>
      leg.kind === "ride"
        ? rideKey(leg)
        : [leg.from, leg.to].map(place => place.isYou ? "you" : `${place.lat},${place.lon}`).join(">")
    )
    .join(" ")

/**
 * Shifts each predicted trip's times by its delays, carried forward from the latest prediction before each stop,
 * with an early bus holding at timepoints for its scheduled time. A connector's next loop starts a layover after
 * its bus gets in, when that's sooner than Umo says.
 * @returns the runs Umo has nothing to say about although it's predicting their route past their start,
 * so they aren't coming (connectors run by headway, not to the timetable)
 */
const applyPredictions = (feed: Feed, model: Model, predictions: StopPredictions[], runs: Run[]) => {
  const runsByTripId = new Map<string, Run[]>()
  for (const run of runs)
    runsByTripId.set(run.trip.id, [...runsByTripId.get(run.trip.id) ?? [], run])

  const known = new Map<Run, Map<number, number>>()
  // The latest time Umo predicts for each route
  const horizon = new Map<string, number>()

  for (const entry of predictions)
    for (const prediction of entry.values) {
      horizon.set(entry.route.id, Math.max(horizon.get(entry.route.id) ?? -Infinity, prediction.timestamp / 1000))

      // The same trip runs on several service days, and loops visit a stop twice,
      // so match the scheduled visit closest in time to the prediction
      const predicted = prediction.timestamp / 1000
      let run: Run | undefined
      let position = 0
      let bestOffset = Infinity
      for (const candidate of prediction.tripId && runsByTripId.get(prediction.tripId) || [])
        candidate.trip.stops.forEach((stop, i) => {
          if (feed.stops[stop].id !== entry.stop.id)
            return
          const offset = Math.abs(candidate.base + candidate.trip.times[i] - predicted)
          if (offset < bestOffset) {
            bestOffset = offset
            run = candidate
            position = i
          }
        })
      if (!run)
        continue

      const delays = known.get(run) ?? new Map()
      delays.set(position, predicted - (run.base + run.trip.times[position]))
      known.set(run, delays)
      run.vehicle = prediction.vehicleId
      // Before a bus starts its trip, Umo predicts from its own schedule
      if (!prediction.affectedByLayover)
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

  return new Set(runs.filter(run =>
    !known.has(run) &&
    run.base + run.trip.times[0] <= (horizon.get(run.trip.route) ?? -Infinity)
  ))
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

/** Every trip running yesterday (past midnight), today, or tomorrow (late night planning) */
export const buildRuns = (feed: Feed, today: Day, predictions: StopPredictions[], model = EMPTY) => {
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

  const notComing = applyPredictions(feed, model, predictions, runs)
  return runs.filter(run => !notComing.has(run))
}

export const buildConnections = (runs: Run[], start: number) => {
  const connections: Connection[] = []
  runs.forEach((run, runIndex) => {
    const { stops } = run.trip
    // Uneven delays could have a bus leave a stop before reaching it, so never go back in time
    let departure = -Infinity
    for (let position = 0; position + 1 < stops.length; position++) {
      departure = Math.max(departure, timeAt(run, position))
      const arrival = Math.max(departure, arrivalAt(run, position + 1))
      if (departure >= start && departure <= start + HORIZON)
        connections.push({
          run: runIndex,
          position,
          from: stops[position],
          to:   stops[position + 1],
          departure,
          arrival
        })
    }
  })
  // Ties keep each trip's connections in order, even for stops no time apart
  return connections.sort((a, b) =>
    a.departure - b.departure ||
    a.arrival - b.arrival ||
    a.position - b.position
  )
}

export type Options = {
  /** The time plans are made at, which uncertainty grows from */
  now: number,
  /** Only one bus, without changing */
  direct?: boolean,
  /** Only this stop to walk to first */
  access?: number
}

type Step =
  | { kind: "origin", meters: number }
  | { kind: "walk", from: number, meters: number, start: number, via: Step }
  | { kind: "ride", board: Connection, alight: Connection, via: Step }

/** The earliest arrival at `to` leaving `from` at `start`, leaving as late as the first bus allows */
export const scan = (
  feed: Feed,
  walks: Walks,
  runs: Run[],
  connections: Connection[],
  from: Place,
  to: Place,
  start: number,
  { now, direct = false, access }: Options
): Itinerary | undefined => {
  const transfers = walks.transfers()
  // The earliest you could be at each stop, for getting off and walking on
  const arrival = new Float64Array(feed.stops.length).fill(Infinity)
  // The earliest you can count on being at each stop, for catching a bus there: later, by how unsure getting there is
  const ready = new Float64Array(feed.stops.length).fill(Infinity)
  const how: (Step | undefined)[] = []
  const readyHow: (Step | undefined)[] = []
  const boarded = new Map<number, { board: Connection, via: Step }>()

  const accessMeters = walks.toStops(from)
  for (const [i, meters] of accessMeters.entries()) {
    if (meters === Infinity || (access !== undefined && i !== access))
      continue
    arrival[i] = start + walkSeconds(meters)
    ready[i] = start + walkAllowance(meters)
    how[i] = readyHow[i] = { kind: "origin", meters }
  }

  const egress = walks.toStops(to)
  let best = Infinity
  let bestStop: number | undefined

  const finishFrom = (stop: number) => {
    if (egress[stop] === Infinity)
      return
    const done = arrival[stop] + walkSeconds(egress[stop])
    if (done < best) {
      best = done
      bestStop = stop
    }
  }

  for (const connection of connections) {
    if (connection.departure < start)
      continue
    if (connection.departure >= best)
      break

    const run = runs[connection.run]
    if (!boarded.has(connection.run)) {
      const via = readyHow[connection.from]
      if (!via || (direct && via.kind !== "origin") || !canBoard(run.trip, connection.position))
        continue
      if (ready[connection.from] + slack(run, connection.position, connection.departure, now) > connection.departure)
        continue
      boarded.set(connection.run, { board: connection, via })
    }
    if (!canAlight(run.trip, connection.position + 1))
      continue

    const { to: stop, arrival: time } = connection
    const step: Step = { kind: "ride", ...boarded.get(connection.run)!, alight: connection }
    const isSooner = time < arrival[stop]
    if (isSooner) {
      arrival[stop] = time
      how[stop] = step
      finishFrom(stop)
    }
    // Getting off is as unsure as when the bus gets there, and without changing buses only leads on to the destination
    const readyAt = time + spread(run, connection.position + 1, time, now)
    const isReadier = !direct && readyAt < ready[stop]
    if (isReadier) {
      ready[stop] = readyAt
      readyHow[stop] = step
    }
    if (!(isSooner || isReadier))
      continue

    for (const [next, meters] of transfers[stop]) {
      if (isSooner && time + walkSeconds(meters) < arrival[next]) {
        arrival[next] = time + walkSeconds(meters)
        how[next] = { kind: "walk", from: stop, meters, start: time, via: step }
        finishFrom(next)
      }
      if (isReadier && readyAt + walkAllowance(meters) < ready[next]) {
        ready[next] = readyAt + walkAllowance(meters)
        readyHow[next] = { kind: "walk", from: stop, meters, start: time, via: step }
      }
    }
  }

  // Walking there is quickest, which isn't a bus itinerary
  if (bestStop === undefined || how[bestStop]!.kind === "origin")
    return

  const place = (stop: number): Place => feed.stops[stop]
  const legs: Leg[] = [{
    kind: "walk",
    from: place(bestStop),
    to,
    start: arrival[bestStop],
    end:   best,
    meters: egress[bestStop]
  }]

  let step = how[bestStop]!
  let at = bestStop
  while (step.kind !== "origin") {
    if (step.kind === "walk") {
      legs.unshift({
        kind: "walk",
        from: place(step.from),
        to:   place(at),
        start: step.start,
        end:   step.start + walkSeconds(step.meters),
        meters: step.meters
      })
      at = step.from
    }
    else {
      legs.unshift({
        kind: "ride",
        run: runs[step.board.run],
        fromPosition: step.board.position,
        toPosition:   step.alight.position + 1,
        start: step.board.departure,
        end:   step.alight.arrival
      })
      at = step.board.from
    }
    step = step.via
  }

  // Leave as late as possible for the first bus instead of waiting at the stop, keeping the slack it needs
  const ride = legs[0] as RideLeg
  const leave = ride.start - slack(ride.run, ride.fromPosition, ride.start, now) - walkAllowance(step.meters)
  legs.unshift({
    kind: "walk",
    from,
    to: place(at),
    start: leave,
    end:   leave + walkSeconds(step.meters),
    meters: step.meters
  })
  return { legs, start: leave, end: best }
}

export const walkOnly = (walks: Walks, from: Place, to: Place, start: number): Itinerary => {
  const { meters } = walks.between(from, to)
  const end = start + walkSeconds(meters)
  return {
    legs: [{ kind: "walk", from, to, start, end, meters }],
    start,
    end
  }
}

export const rides = (itinerary: Itinerary) =>
  itinerary.legs.filter(leg => leg.kind === "ride").length

/** How long an itinerary feels from `now`, which is what options are ranked by */
export const cost = (itinerary: Itinerary, now: number) => {
  let walking = 0
  let waiting = 0
  let riding = 0
  let at = itinerary.start
  for (const leg of itinerary.legs) {
    waiting += leg.start - at
    if (leg.kind === "walk")
      walking += leg.end - leg.start
    else
      riding += leg.end - leg.start
    at = leg.end
  }
  return (
    (itinerary.start - now) * WAIT_AT_HOME +
    riding +
    walking * WALK_RELUCTANCE +
    waiting * WAIT_AT_STOP +
    Math.max(0, rides(itinerary) - 1) * TRANSFER_PENALTY
  )
}

/** The buses an itinerary rides, which is what makes options different to a rider */
const busesOf = (itinerary: Itinerary) =>
  itinerary.legs
    .flatMap(leg => leg.kind === "ride" ? [`${leg.run.trip.id}@${leg.run.base}`] : [])
    .join(" ")

/**
 * The best bus itineraries leaving at or after `now`, best first: each feels better than walking right away, rides
 * a different set of buses, and only changes buses to arrive well before anything simpler would
 */
export const plan = (feed: Feed, walks: Walks, runs: Run[], from: Place, to: Place, now: number) => {
  const connections = buildConnections(runs, now)
  const walk = walkOnly(walks, from, to, now)
  const nearest = [...walks.toStops(from).entries()]
    .filter(([, meters]) => meters < Infinity)
    .sort((a, b) => a[1] - b[1])

  // The next few first buses, with and without changing: the quickest way on each, and from the nearer stops
  // it could start at instead, which can be worth a little longer on the bus
  const candidates: Itinerary[] = []
  for (const direct of [true, false]) {
    let after = now
    for (let i = 0; i < DEPARTURES; i++) {
      const quickest = scan(feed, walks, runs, connections, from, to, after, { now, direct })
      if (!quickest)
        break
      candidates.push(quickest)
      const meters = (quickest.legs[0] as WalkLeg).meters
      for (const [access] of nearest.filter(([, walk]) => walk < meters).slice(0, NEARER_STOPS)) {
        const nearer = scan(feed, walks, runs, connections, from, to, after, { now, direct, access })
        if (nearer)
          candidates.push(nearer)
      }
      after = quickest.start + 1
    }
  }

  // One option per set of buses, whichever feels best
  const best = new Map<string, Itinerary>()
  for (const candidate of candidates) {
    const key = busesOf(candidate)
    if (!best.has(key) || cost(candidate, now) < cost(best.get(key)!, now))
      best.set(key, candidate)
  }

  // Changing buses has to arrive well before anything simpler, of all that was found, and walking the whole way is
  // the simplest of all
  const soonestWith = (count: number) =>
    Math.min(walk.end, ...candidates.filter(candidate => rides(candidate) <= count).map(candidate => candidate.end))

  return [...best.values()]
    .filter(option => cost(option, now) < cost(walk, now) - MIN_TIME_SAVED)
    .filter(option => rides(option) === 1 || option.end + MIN_TRANSFER_GAIN <= soonestWith(rides(option) - 1))
    .sort((a, b) => cost(a, now) - cost(b, now))
    .slice(0, ALTERNATIVES)
}
