// Trip planning with the Connection Scan Algorithm (https://arxiv.org/abs/1703.05997) over the day's runs as
// forecast.mts predicts them: the timetable shifted by what's known of each bus, holding at timepoints.
//
// Every boarding leaves slack for how unsure the bus's departure is. Nearer first stops are tried as well as whichever
// arrives first, so ranking can weigh walking against waiting

import { type Feed, canAlight, canBoard } from "../transit/feed.mts"
import { type Via, type Walks, walkAllowance, walkSeconds } from "./walks.mts"
import { type Run, arrivalAt, slack, spread, timeAt } from "../transit/models/forecast.mts"
import type { Place } from "../places/search.mts"

export const HORIZON = 4 * 3600      // s, how far ahead to look for buses
export const ALTERNATIVES = 3
const DEPARTURES = 6                 // first buses considered, with and without changing buses
const NEARER_STOPS = 8               // first stops nearer than the quickest one's to try as well
export const MIN_TIME_SAVED = 120    // s, a bus has to feel this much better than walking now
export const MIN_TRANSFER_GAIN = 300 // s, changing buses has to arrive this much sooner than any option with fewer

// How long an itinerary feels, relative to riding
const WALK_RELUCTANCE = 2            // walking feels twice as long
const WAIT_AT_STOP = 1.5             // waiting at a stop feels longer than riding
const WAIT_AT_HOME = 0.5             // waiting before leaving feels half as long
const TRANSFER_PENALTY = 300         // s, the hassle of changing buses, on top of the wait

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
  | { kind: "origin", meters: number, via: Via }
  | { kind: "walk", from: number, meters: number, via: Via, start: number, before: Step }
  | { kind: "ride", board: Connection, alight: Connection, before: Step }

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
  const boarded = new Map<number, { board: Connection, before: Step }>()

  const accessWalks = walks.toStops(from)
  for (const [i, meters] of accessWalks.meters.entries()) {
    if (meters === Infinity || (access !== undefined && i !== access))
      continue
    const via = accessWalks.via[i]
    arrival[i] = start + walkSeconds(meters)
    ready[i] = start + walkAllowance(meters, via)
    how[i] = readyHow[i] = { kind: "origin", meters, via }
  }

  const egress = walks.toStops(to)
  let best = Infinity
  let bestStop: number | undefined

  const finishFrom = (stop: number) => {
    if (egress.meters[stop] === Infinity)
      return
    const done = arrival[stop] + walkSeconds(egress.meters[stop])
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
      const before = readyHow[connection.from]
      if (!before || (direct && before.kind !== "origin") || !canBoard(run.trip, connection.position))
        continue
      if (ready[connection.from] + slack(run, connection.position, connection.departure, now) > connection.departure)
        continue
      boarded.set(connection.run, { board: connection, before })
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
    // Getting off is as unsure as when the bus gets there. Without changing buses, it only leads on to the destination
    const readyAt = time + spread(run, connection.position + 1, time, now)
    const isReadier = !direct && readyAt < ready[stop]
    if (isReadier) {
      ready[stop] = readyAt
      readyHow[stop] = step
    }
    if (!(isSooner || isReadier))
      continue

    // A timed transfer counts on the walk's allowance, which is larger for an estimate
    for (const { to: next, meters, via } of transfers[stop]) {
      if (isSooner && time + walkSeconds(meters) < arrival[next]) {
        arrival[next] = time + walkSeconds(meters)
        how[next] = { kind: "walk", from: stop, meters, via, start: time, before: step }
        finishFrom(next)
      }
      if (isReadier && readyAt + walkAllowance(meters, via) < ready[next]) {
        ready[next] = readyAt + walkAllowance(meters, via)
        readyHow[next] = { kind: "walk", from: stop, meters, via, start: time, before: step }
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
    meters: egress.meters[bestStop]
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
    step = step.before
  }

  // Leave as late as possible for the first bus instead of waiting at the stop, keeping the slack it needs
  const ride = legs[0] as RideLeg
  const leave = ride.start - slack(ride.run, ride.fromPosition, ride.start, now) - walkAllowance(step.meters, step.via)
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
  const nearest = [...walks.toStops(from).meters.entries()]
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
