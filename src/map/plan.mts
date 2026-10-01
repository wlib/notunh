// Trip planning with the Connection Scan Algorithm over the GTFS schedule,
// shifted by Umo's predictions (their trip ids match the GTFS trip ids)
// https://arxiv.org/abs/1703.05997

import { type Feed, type Trip, addDays, distance, isServiceActive, serviceDayStart } from "./feed.mts"
import type { StopPredictions } from "./umo.mts"

const WALK_SPEED = 1.3               // m/s
const WALK_DETOUR = 1.25             // straight line -> street distance
export const MAX_ACCESS_WALK = 1600  // m, to the first stop or from the last
export const MAX_TRANSFER_WALK = 400 // m, between stops
export const TRANSFER_BUFFER = 60    // s, to make a connection between buses
export const HORIZON = 4 * 3600      // s, how far ahead to look for buses
export const ALTERNATIVES = 3
const CANDIDATES = 6                 // departures considered before ranking
export const MIN_TIME_SAVED = 120    // s, a bus has to feel this much better than walking now

// How long an itinerary feels, relative to riding
const WALK_RELUCTANCE = 2            // walking feels twice as long
const WAIT_AT_HOME = 0.5             // waiting before leaving feels half as long
const TRANSFER_PENALTY = 180         // s, the hassle of changing buses

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
  /** Seconds of delay at each stop, aligned with trip.stops */
  delays: number[],
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

export const timeAt = (run: Run, position: number) =>
  run.base + run.trip.times[position] + run.delays[position]

/** Identifies an itinerary across replans, changing only when its trips or times do */
export const itineraryKey = (itinerary: Itinerary) =>
  itinerary.legs
    .map(leg =>
      leg.kind === "ride"
        ? `${leg.run.trip.id}@${leg.run.base}:${leg.fromPosition}-${leg.toPosition}`
        : "walk"
    )
    .join(" ") + ` ${itinerary.start}-${itinerary.end}`

/**
 * Shifts each predicted trip's times by its delays, carried forward from the latest prediction before each stop.
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

  for (const [run, delays] of known) {
    let delay = delays.get(Math.min(...delays.keys()))!
    for (let position = 0; position < run.delays.length; position++) {
      delay = delays.get(position) ?? delay
      run.delays[position] = delay
    }
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

/** The same connections in reverse: latest arrival first, and each trip's connections backward */
export const byArrival = (connections: Connection[]) =>
  connections.toSorted((a, b) =>
    b.arrival - a.arrival ||
    b.departure - a.departure ||
    b.position - a.position
  )

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

type Arrival =
  | { kind: "origin", meters: number }
  | { kind: "walk", from: number, meters: number, start: number }
  | { kind: "ride", board: Connection, alight: Connection }

/** The earliest arrival at `to` leaving `from` at `start` */
export const scan = (
  feed: Feed,
  runs: Run[],
  connections: Connection[],
  from: Place,
  to: Place,
  start: number
): Itinerary | undefined => {
  const transfers = transfersFor(feed)
  const arrival = new Float64Array(feed.stops.length).fill(Infinity)
  const ready = new Float64Array(feed.stops.length).fill(Infinity)
  const how: (Arrival | undefined)[] = []
  const boarded = new Map<number, Connection>()

  for (const [i, stop] of feed.stops.entries()) {
    const meters = distance(from, stop)
    if (meters > MAX_ACCESS_WALK)
      continue
    arrival[i] = ready[i] = start + walkSeconds(meters)
    how[i] = { kind: "origin", meters }
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

    const isOnboard = boarded.has(connection.run)
    if (!isOnboard && ready[connection.from] > connection.departure)
      continue
    if (!isOnboard)
      boarded.set(connection.run, connection)

    const { to: stop, arrival: time } = connection
    if (time >= arrival[stop])
      continue

    arrival[stop] = time
    ready[stop] = time + TRANSFER_BUFFER
    how[stop] = { kind: "ride", board: boarded.get(connection.run)!, alight: connection }
    finishFrom(stop)

    for (const [next, meters] of transfers[stop]) {
      const walked = time + walkSeconds(meters)
      if (walked >= arrival[next])
        continue
      arrival[next] = walked
      ready[next] = walked + TRANSFER_BUFFER
      how[next] = { kind: "walk", from: stop, meters, start: time }
      finishFrom(next)
    }
  }

  if (bestStop === undefined)
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

  let stop = bestStop
  while (true) {
    const step = how[stop]!
    if (step.kind === "origin") {
      legs.unshift({
        kind: "walk",
        from,
        to: place(stop),
        start,
        end: arrival[stop],
        meters: step.meters
      })
      break
    }
    else if (step.kind === "walk") {
      legs.unshift({
        kind: "walk",
        from: place(step.from),
        to:   place(stop),
        start: step.start,
        end:   arrival[stop],
        meters: step.meters
      })
      stop = step.from
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
      stop = step.board.from
    }
  }

  // Leave as late as possible for the first bus instead of waiting at the stop
  const [first, second] = legs
  if (first.kind === "walk" && second?.kind === "ride") {
    first.end = second.start
    first.start = first.end - walkSeconds(first.meters)
  }

  return {
    legs,
    start: legs[0].start,
    end: best
  }
}

/**
 * Connection scan in reverse:
 * the latest time to leave `from` and still reach `to` by `deadline`
 * @param reversed connections from byArrival()
 */
export const latestDeparture = (feed: Feed, reversed: Connection[], from: Place, to: Place, deadline: number) => {
  const transfers = transfersFor(feed)
  // The latest time a bus can drop you at each stop and still make it
  const latest = new Float64Array(feed.stops.length).fill(-Infinity)
  const onboard = new Set<number>()

  for (const [i, stop] of feed.stops.entries()) {
    const meters = distance(stop, to)
    if (meters <= MAX_ACCESS_WALK)
      latest[i] = deadline - walkSeconds(meters)
  }
  for (const [i, time] of [...latest.entries()])
    for (const [next, meters] of transfers[i])
      latest[next] = Math.max(latest[next], time - walkSeconds(meters))

  let best = -Infinity
  for (const connection of reversed) {
    if (connection.arrival > deadline)
      continue
    if (!onboard.has(connection.run) && connection.arrival > latest[connection.to])
      continue
    onboard.add(connection.run)

    const { from: stop, departure } = connection
    const access = distance(from, feed.stops[stop])
    if (access <= MAX_ACCESS_WALK)
      best = Math.max(best, departure - walkSeconds(access))

    latest[stop] = Math.max(latest[stop], departure - TRANSFER_BUFFER)
    for (const [next, meters] of transfers[stop])
      latest[next] = Math.max(latest[next], departure - TRANSFER_BUFFER - walkSeconds(meters))
  }

  return best
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

const duration = (itinerary: Itinerary) =>
  itinerary.end - itinerary.start

/** Leaves no earlier and arrives no later, and differs */
const dominates = (a: Itinerary, b: Itinerary) =>
  a.start >= b.start && a.end <= b.end && (a.start > b.start || a.end < b.end)

const hasRide = (itinerary: Itinerary | undefined): itinerary is Itinerary =>
  itinerary?.legs.some(leg => leg.kind === "ride") ?? false

/** How long an itinerary feels from `now`, which is what options are ranked by */
export const cost = (itinerary: Itinerary, now: number) => {
  const walking = itinerary.legs
    .filter(leg => leg.kind === "walk")
    .reduce((total, leg) => total + leg.end - leg.start, 0)
  const rides = itinerary.legs.filter(leg => leg.kind === "ride").length
  return (
    (itinerary.start - now) * WAIT_AT_HOME +
    duration(itinerary) +
    walking * (WALK_RELUCTANCE - 1) +
    Math.max(0, rides - 1) * TRANSFER_PENALTY
  )
}

/**
 * The best bus itineraries leaving at or after `start`, best first:
 * each feels better than walking right away, and leaves as late as possible for its arrival time
 */
export const plan = (feed: Feed, runs: Run[], from: Place, to: Place, start: number) => {
  const connections = buildConnections(runs, start)
  const reversed = byArrival(connections)
  const walking = cost(walkOnly(from, to, start), start)
  const candidates: Itinerary[] = []

  // The earliest arrival leaving at each time, from now on: a long walk to catch an earlier bus,
  // then the next bus a short walk away, and so on
  let after = start
  for (let i = 0; i < CANDIDATES * 3 && candidates.length < CANDIDATES; i++) {
    const earliest = scan(feed, runs, connections, from, to, after)
    if (!hasRide(earliest))
      break

    // Arrive just as early, but leave as late as possible instead of waiting around
    const leave = latestDeparture(feed, reversed, from, to, earliest.end)
    const latest = leave > after ? scan(feed, runs, connections, from, to, leave) : undefined
    const itinerary =
      hasRide(latest) && latest.end <= earliest.end
        ? latest
        : earliest

    if (cost(itinerary, start) < walking - MIN_TIME_SAVED)
      candidates.push(itinerary)
    after = itinerary.start + 60
  }

  return candidates
    .filter(itinerary => !candidates.some(other => dominates(other, itinerary)))
    .sort((a, b) => cost(a, start) - cost(b, start))
    .slice(0, ALTERNATIVES)
}
