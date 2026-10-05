// Trip planning with the Connection Scan Algorithm over the GTFS schedule,
// shifted by Umo's predictions (their trip ids match the GTFS trip ids)
// https://arxiv.org/abs/1703.05997
//
// Every boarding leaves slack for how unsure the bus's departure is, buses hold at timepoints for their scheduled
// time, and nearer first stops are tried as well as whichever arrives first, so ranking can weigh walking against
// waiting

import { type Feed, type Trip, addDays, distance, isServiceActive, serviceDayStart } from "./feed.mts"
import type { StopPredictions } from "./umo.mts"

const WALK_SPEED = 1.3               // m/s
const WALK_DETOUR = 1.25             // straight line -> street distance
const WALK_WIGGLE = 0.1              // a walk may take this much longer: a slow day, or a longer way round
export const MAX_ACCESS_WALK = 1600  // m, to the first stop or from the last
export const MAX_TRANSFER_WALK = 400 // m, between stops
export const HORIZON = 4 * 3600      // s, how far ahead to look for buses
export const ALTERNATIVES = 3
const DEPARTURES = 6                 // first buses considered, with and without changing buses
const NEARER_STOPS = 8               // first stops nearer than the quickest one's to try as well
export const MIN_TIME_SAVED = 120    // s, a bus has to feel this much better than walking now
export const MIN_TRANSFER_GAIN = 300 // s, changing buses has to arrive this much sooner than any option with fewer

// How far off a predicted departure may be, growing with how far ahead it is. Live predictions were seen off by up
// to a minute or two, and Umo's guesses for a connector's next loop by far more
const UNCERTAINTY_NOW = 60           // s, even for a bus due now
const UNCERTAINTY_RATE = 5           // s more per minute ahead
const UNCERTAINTY_MAX = 240          // s
const SCHEDULE_FACTOR = 2            // a time from the timetable, with no bus tracked, is this much more uncertain
export const BOARDING = 30           // s, to get on a bus waiting at the stop for its scheduled time
// Connectors don't wait for their timetable at the end of a loop, only a couple of minutes, so a bus's next loop
// starts this long after it gets in, when that's sooner than Umo says
export const LAYOVER = 120           // s

// How long an itinerary feels, relative to riding
const WALK_RELUCTANCE = 2            // walking feels twice as long
const WAIT_AT_STOP = 1.5             // waiting at a stop feels longer than riding
const WAIT_AT_HOME = 0.5             // waiting before leaving feels half as long
const TRANSFER_PENALTY = 300         // s, the hassle of changing buses, on top of the wait

export type Place = {
  lat:  number,
  lon:  number,
  name: string
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
  /** A tracked bus is on this trip, rather than Umo predicting from its schedule */
  isLive: boolean,
  /** The bus Umo expects to run this trip */
  vehicle?: string
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

export const walkSeconds = (meters: number) =>
  Math.round(meters * WALK_DETOUR / WALK_SPEED)

/** How long to allow for a walk, for a slow day or a longer way round */
export const walkAllowance = (meters: number) =>
  Math.round(walkSeconds(meters) * (1 + WALK_WIGGLE))

/** When the bus leaves a stop */
export const timeAt = (run: Run, position: number) =>
  run.base + run.trip.times[position] + run.delays[position]

/** How far off a time `lead` seconds ahead may be */
export const uncertainty = (lead: number) =>
  Math.min(UNCERTAINTY_MAX, UNCERTAINTY_NOW + UNCERTAINTY_RATE * Math.max(0, lead) / 60)

/** A bus waiting at a timepoint for its scheduled time can't leave early */
const isHeld = (run: Run, position: number) =>
  run.trip.timepoints.includes(position) && run.delays[position] <= 0

/** How early to be at a stop for a bus leaving it at `departure` */
export const slack = (run: Run, position: number, departure: number, now: number) =>
  isHeld(run, position)
    ? BOARDING
    : uncertainty(departure - now) * (run.isLive ? 1 : SCHEDULE_FACTOR)

/** The trip a bus is on or about to start, from Umo's predictions: of those it's running, the one ending soonest */
export const runOf = (runs: Run[], vehicle: string, now: number) =>
  runs
    .filter(run => run.vehicle === vehicle && timeAt(run, run.trip.stops.length - 1) >= now)
    .sort((a, b) => timeAt(a, a.trip.stops.length - 1) - timeAt(b, b.trip.stops.length - 1))[0] as Run | undefined

/** Identifies an itinerary across replans, changing only when its trips or times to the minute do */
export const itineraryKey = (itinerary: Itinerary) =>
  itinerary.legs
    .map(leg =>
      leg.kind === "ride"
        ? `${leg.run.trip.id}@${leg.run.base}:${leg.fromPosition}-${leg.toPosition}`
        : "walk"
    )
    .join(" ") + ` ${Math.floor(itinerary.start / 60)}-${Math.floor(itinerary.end / 60)}`

/**
 * Shifts each predicted trip's times by its delays, carried forward from the latest prediction before each stop,
 * with an early bus holding at timepoints for its scheduled time. A connector's next loop starts a layover after
 * its bus gets in, when that's sooner than Umo says.
 * @returns the runs Umo has nothing to say about although it's predicting their route past their start,
 * so they aren't coming (connectors run by headway, not to the timetable)
 */
const applyPredictions = (feed: Feed, predictions: StopPredictions[], runs: Run[]) => {
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
      for (const candidate of runsByTripId.get(prediction.tripId) ?? [])
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
      const hold = run.trip.timepoints.includes(position) ? Math.max(0, -(delay + held)) : 0
      held += hold
      run.holds[position] = hold
      run.delays[position] = delay + held
    }
  }

  // A bus's next loop, unless it waits for its scheduled start, begins a layover after the loop it's on ends
  for (const run of known.keys()) {
    if (run.isLive || run.trip.timepoints.includes(0))
      continue
    const start = timeAt(run, 0)
    const sameBus = [...known.keys()].filter(other => other.vehicle === run.vehicle)
    // Only the loop right after the one it's on, as the ones after that follow on from it
    if (sameBus.some(other => !other.isLive && timeAt(other, 0) < start))
      continue
    const end = Math.max(...sameBus.filter(other => other.isLive).map(other => timeAt(other, other.trip.stops.length - 1)))
    if (Number.isFinite(end) && end <= start)
      run.delays = run.delays.map(delay => delay + Math.min(0, end + LAYOVER - start))
  }

  return new Set(runs.filter(run =>
    !known.has(run) &&
    run.base + run.trip.times[0] <= (horizon.get(run.trip.route) ?? -Infinity)
  ))
}

/** Every trip running yesterday (past midnight), today, or tomorrow (late night planning) */
export const buildRuns = (feed: Feed, today: number, predictions: StopPredictions[]) => {
  const runs: Run[] = []
  for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
    const base = serviceDayStart(date) / 1000
    for (const trip of feed.trips)
      if (isServiceActive(feed.services[trip.service], date))
        runs.push({
          trip,
          base,
          delays: trip.times.map(() => 0),
          holds:  trip.times.map(() => 0),
          isLive: false
        })
  }

  const notComing = applyPredictions(feed, predictions, runs)
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
      const arrival = Math.max(departure, timeAt(run, position + 1))
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

const transfersCache = new WeakMap<Feed, [number, number][][]>()

const transfersFor = (feed: Feed) => {
  const cached = transfersCache.get(feed)
  if (cached)
    return cached

  const transfers = feed.stops.map((a, i) =>
    feed.stops.flatMap((b, j) => {
      const meters = distance(a, b)
      return i !== j && meters <= MAX_TRANSFER_WALK
        ? [[j, meters] as [number, number]]
        : []
    })
  )
  transfersCache.set(feed, transfers)
  return transfers
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
  runs: Run[],
  connections: Connection[],
  from: Place,
  to: Place,
  start: number,
  { now, direct = false, access }: Options
): Itinerary | undefined => {
  const transfers = transfersFor(feed)
  // The earliest you could be at each stop, for getting off and walking on
  const arrival = new Float64Array(feed.stops.length).fill(Infinity)
  // The earliest you can count on being at each stop, for catching a bus there: later, by how unsure getting there is
  const ready = new Float64Array(feed.stops.length).fill(Infinity)
  const how: (Step | undefined)[] = []
  const readyHow: (Step | undefined)[] = []
  const boarded = new Map<number, { board: Connection, via: Step }>()

  for (const [i, stop] of feed.stops.entries()) {
    const meters = distance(from, stop)
    if (meters > MAX_ACCESS_WALK || (access !== undefined && i !== access))
      continue
    arrival[i] = start + walkSeconds(meters)
    ready[i] = start + walkAllowance(meters)
    how[i] = readyHow[i] = { kind: "origin", meters }
  }

  const egress = feed.stops.map(stop => distance(stop, to))
  let best = Infinity
  let bestStop: number | undefined

  const finishFrom = (stop: number) => {
    if (egress[stop] > MAX_ACCESS_WALK)
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

    if (!boarded.has(connection.run)) {
      const via = readyHow[connection.from]
      if (!via || (direct && via.kind !== "origin"))
        continue
      const run = runs[connection.run]
      if (ready[connection.from] + slack(run, connection.position, connection.departure, now) > connection.departure)
        continue
      boarded.set(connection.run, { board: connection, via })
    }

    const { to: stop, arrival: time } = connection
    const step: Step = { kind: "ride", ...boarded.get(connection.run)!, alight: connection }
    const isSooner = time < arrival[stop]
    if (isSooner) {
      arrival[stop] = time
      how[stop] = step
      finishFrom(stop)
    }
    // Getting off is as unsure as when the bus gets there, and without changing buses only leads on to the destination
    const readyAt = time + uncertainty(time - now)
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

export const walkOnly = (from: Place, to: Place, start: number): Itinerary => {
  const meters = distance(from, to)
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
export const plan = (feed: Feed, runs: Run[], from: Place, to: Place, now: number) => {
  const connections = buildConnections(runs, now)
  const walk = walkOnly(from, to, now)
  const nearest = feed.stops
    .map((stop, i) => [i, distance(from, stop)] as const)
    .filter(([, meters]) => meters <= MAX_ACCESS_WALK)
    .sort((a, b) => a[1] - b[1])

  // The next few first buses, with and without changing: the quickest way on each, and from the nearer stops
  // it could start at instead, which can be worth a little longer on the bus
  const candidates: Itinerary[] = []
  for (const direct of [true, false]) {
    let after = now
    for (let i = 0; i < DEPARTURES; i++) {
      const quickest = scan(feed, runs, connections, from, to, after, { now, direct })
      if (!quickest)
        break
      candidates.push(quickest)
      const meters = (quickest.legs[0] as WalkLeg).meters
      for (const [access] of nearest.filter(([, walk]) => walk < meters).slice(0, NEARER_STOPS)) {
        const nearer = scan(feed, runs, connections, from, to, after, { now, direct, access })
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
