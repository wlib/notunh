// Trip planning with the Connection Scan Algorithm (https://arxiv.org/abs/1703.05997) over the day's runs as
// forecast.mts predicts them: the timetable shifted by what's known of each bus, holding at timepoints.
//
// Every boarding leaves slack for how unsure the bus's departure is. Nearer first stops are tried as well as whichever
// arrives first, so ranking can weigh walking against waiting, and the last stop is the one that feels soonest, which
// is to ride on to a stop nearer the end rather than get off early and walk, unless getting off early saves real time

import { type Feed, canAlight, canBoard } from "../transit/feed.mts"
import { type Via, type Walks, walkAllowance, walkSeconds } from "./walks.mts"
import { type Run, slack, spread } from "../transit/models/forecast.mts"
import type { Place } from "../places/search.mts"

export const HORIZON = 4 * 3600      // s, how far ahead to look for buses
export const ALTERNATIVES = 5
const DEPARTURES = 6                 // first buses considered, with and without changing buses
const STEP = 60                      // s planBy looks on by while there's no bus to catch yet
const NEARER_STOPS = 8               // first stops nearer than the quickest one's to try as well
export const WALK_OFFERED = 30 * 60  // s, walking the whole way is offered up to this long however the buses do

// How long an itinerary feels, relative to riding
export const WALK_RELUCTANCE = 2     // walking feels twice as long
const WAIT_AT_STOP = 1.5             // waiting at a stop feels longer than riding
const WAIT_AT_HOME = 0.5             // waiting before leaving feels half as long
const EARLY_THERE = 1                // being there before the time asked feels as long as it is: not home, not a stop
const TRANSFER_PENALTY = 300         // s, the hassle of changing buses, on top of the wait

export type WalkLeg = {
  kind:   "walk",
  from:   Place,
  to:     Place,
  start:  number,
  end:    number,
  meters: number,
  /** How the walk is known, which sets its allowance (walks.mts) */
  via:    Via
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
      positions.every(position => leg.run.arrivals[position] === other.run.arrivals[position] && leg.run.departures[position] === other.run.departures[position])
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

/** The connections leaving between `start` and `until`, which is HORIZON on unless there's a time to get there by later than that */
export const buildConnections = (runs: Run[], start: number, until = start + HORIZON) => {
  const connections: Connection[] = []
  runs.forEach((run, runIndex) => {
    const { stops } = run.trip
    // A live source's uneven delays, or the handoff back to the timetable, could have a bus leave a stop before
    // reaching it, so never go back in time
    let departure = -Infinity
    for (let position = 0; position + 1 < stops.length; position++) {
      departure = Math.max(departure, run.departures[position])
      const arrival = Math.max(departure, run.arrivals[position + 1])
      if (departure >= start && departure <= until)
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
  access?: number,
  /** Buses taken already, by the position each was boarded at, not to board again there or before: only further on, as a loop's bus comes round */
  skip?: ReadonlyMap<Run, number>,
  /**
   * A time to be there by: of the ways there by then, the one that feels soonest, which rides on to a stop nearer the
   * end rather than walk from an earlier one. With none there by then, the earliest way there, late as it is
   */
  by?: number
}

type Step =
  | { kind: "origin", meters: number, via: Via }
  | { kind: "walk", from: number, meters: number, via: Via, start: number, before: Step }
  | { kind: "ride", board: Connection, alight: Connection, before: Step }

/**
 * The bus itinerary from `from` leaving at `start` that feels soonest at `to`: there earliest, counting the walk from
 * the last bus as WALK_RELUCTANCE does, leaving as late as the first bus allows. Walking to a stop never stands in
 * for a bus getting there, as walking the whole way is weighed against the buses by the caller
 */
export const scan = (
  feed: Feed,
  walks: Walks,
  runs: Run[],
  connections: Connection[],
  from: Place,
  to: Place,
  start: number,
  { now, direct = false, access, skip, by = Infinity }: Options
): Itinerary | undefined => {
  const transfers = walks.transfers()
  // The earliest a bus gets you to each stop, for getting off and walking on
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
    ready[i] = start + walkAllowance(meters, via)
    readyHow[i] = { kind: "origin", meters, via }
  }

  const egress = walks.toStops(to)
  // The earliest there from any stop, and the stop it feels soonest from of those there by `by`
  let earliest = Infinity
  let earliestStop: number | undefined
  let felt = Infinity
  let feltStop: number | undefined

  const finishFrom = (stop: number) => {
    const walk = walkSeconds(egress.meters[stop])
    if (walk === Infinity)
      return
    const done = arrival[stop] + walk
    if (done < earliest) {
      earliest = done
      earliestStop = stop
    }
    if (done <= by && arrival[stop] + walk * WALK_RELUCTANCE < felt) {
      felt = arrival[stop] + walk * WALK_RELUCTANCE
      feltStop = stop
    }
  }

  for (const connection of connections) {
    if (connection.departure < start)
      continue
    // Nothing leaving later feels sooner, or, with nothing there by `by` yet, gets there by it or earlier
    if (connection.departure >= (feltStop === undefined ? Math.max(earliest, by) : felt))
      break

    const run = runs[connection.run]
    if (!boarded.has(connection.run)) {
      const before = readyHow[connection.from]
      if (!before || (direct && before.kind !== "origin") || connection.position <= (skip?.get(run) ?? -1) || !canBoard(run.trip, connection.position))
        continue
      if (ready[connection.from] + slack(run, connection.position, connection.departure, now) > connection.departure)
        continue
      boarded.set(connection.run, { board: connection, before })
    }
    if (!canAlight(run.trip, connection.position + 1))
      continue

    const { to: stop, arrival: time } = connection
    const step: Step = { kind: "ride", ...boarded.get(connection.run)!, alight: connection }
    if (time < arrival[stop]) {
      arrival[stop] = time
      how[stop] = step
      finishFrom(stop)
    }
    // Getting off is as unsure as when the bus gets there. Without changing buses, it only leads on to the destination
    const readyAt = time + spread(run, connection.position + 1, time, now)
    if (direct || readyAt >= ready[stop])
      continue
    ready[stop] = readyAt
    readyHow[stop] = step

    // A timed transfer counts on the walk's allowance, which is larger for an estimate
    for (const { to: next, meters, via } of transfers[stop])
      if (readyAt + walkAllowance(meters, via) < ready[next]) {
        ready[next] = readyAt + walkAllowance(meters, via)
        readyHow[next] = { kind: "walk", from: stop, meters, via, start: time, before: step }
      }
  }

  const last = feltStop ?? earliestStop
  if (last === undefined)
    return

  const place = (stop: number): Place => feed.stops[stop]
  const legs: Leg[] = [{
    kind: "walk",
    from: place(last),
    to,
    start: arrival[last],
    end:   arrival[last] + walkSeconds(egress.meters[last]),
    meters: egress.meters[last],
    via:    egress.via[last]
  }]

  let step = how[last]!
  let at = last
  while (step.kind !== "origin") {
    if (step.kind === "walk") {
      legs.unshift({
        kind: "walk",
        from: place(step.from),
        to:   place(at),
        start: step.start,
        end:   step.start + walkSeconds(step.meters),
        meters: step.meters,
        via:    step.via
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
    meters: step.meters,
    via:    step.via
  })
  return { legs, start: leave, end: legs.at(-1)!.end }
}

export const walkOnly = (walks: Walks, from: Place, to: Place, start: number): Itinerary => {
  const { meters, via } = walks.between(from, to)
  const end = start + walkSeconds(meters)
  return {
    legs: [{ kind: "walk", from, to, start, end, meters, via }],
    start,
    end
  }
}

/** Walking the whole way so as to be there by `by`, leaving the walk's allowance before, as a walk to a bus is left */
export const walkBy = (walks: Walks, from: Place, to: Place, by: number) => {
  const { meters, via } = walks.between(from, to)
  return walkOnly(walks, from, to, by - walkAllowance(meters, via))
}

/** Whether walking the whole way, taking some seconds, is an offer by its length alone, whatever the buses do */
export const isWalkOffered = (seconds: number) =>
  seconds <= WALK_OFFERED

/** The stops nearer a place than some meters, nearest first, to try starting from as well as the quickest one's */
const nearerStops = (walks: Walks, from: Place) =>
  [...walks.toStops(from).meters.entries()]
    .filter(([, meters]) => meters < Infinity)
    .sort((a, b) => a[1] - b[1])

/**
 * The ways that feel soonest from each of the next first buses, with and without changing: scan from `now`, then
 * from wherever `next` says to scan from given what was found, leaving out the first buses found so far, until it
 * says to stop, and from the nearer stops each could start at instead. With a time to be there `by`, buses up to then
 * are looked at, however far ahead
 */
const candidatesOf = (feed: Feed, walks: Walks, runs: Run[], from: Place, to: Place, now: number, by: number | undefined, next: (after: number, quickest: Itinerary | undefined, scans: number) => number | undefined) => {
  const connections = buildConnections(runs, now, Math.max(now + HORIZON, by ?? now))
  const nearest = nearerStops(walks, from)
  const candidates: Itinerary[] = []
  for (const direct of [true, false]) {
    const skip = new Map<Run, number>()
    let after: number | undefined = now
    for (let scans = 1; after !== undefined; scans++) {
      const quickest = scan(feed, walks, runs, connections, from, to, after, { now, direct, skip, by })
      if (quickest) {
        candidates.push(quickest)
        const meters = (quickest.legs[0] as WalkLeg).meters
        for (const [access] of nearest.filter(([, walk]) => walk < meters).slice(0, NEARER_STOPS)) {
          const nearer = scan(feed, walks, runs, connections, from, to, after, { now, direct, access, skip, by })
          if (nearer)
            candidates.push(nearer)
        }
        const first = quickest.legs.find(leg => leg.kind === "ride") as RideLeg
        skip.set(first.run, first.fromPosition)
      }
      after = next(after, quickest, scans)
    }
  }
  return candidates
}

/** Meters walked over an itinerary */
const walking = (itinerary: Itinerary) =>
  itinerary.legs.reduce((meters, leg) => meters + (leg.kind === "walk" ? leg.meters : 0), 0)

export const rides = (itinerary: Itinerary) =>
  itinerary.legs.filter(leg => leg.kind === "ride").length

/**
 * Whether `a` is at least as good a way as `b` on every count a rider weighs, and better on one: it leaves no earlier,
 * gets there no later, walks no further and changes buses no more
 */
export const dominates = (a: Itinerary, b: Itinerary) =>
  a.start >= b.start && a.end <= b.end && walking(a) <= walking(b) && rides(a) <= rides(b) &&
  (a.start > b.start || a.end < b.end || walking(a) < walking(b) || rides(a) < rides(b))

/** The buses an itinerary rides, which is what makes options different to a rider */
const busesOf = (itinerary: Itinerary) =>
  itinerary.legs
    .flatMap(leg => leg.kind === "ride" ? [`${leg.run.trip.id}@${leg.run.base}`] : [])
    .join(" ")

/**
 * The options among some candidates, best by `cost` first, up to ALTERNATIVES: the best way of catching each set of
 * buses, less any that another beats on every count, and any that walks no less than walking the whole way, `meters`,
 * which is no way by bus at all. Walking the whole way is otherwise left to the caller, and never hides a bus
 */
const options = (candidates: Itinerary[], meters: number, now: number, by?: number) => {
  const best = new Map<string, Itinerary>()
  for (const candidate of candidates.filter(candidate => walking(candidate) < meters).sort((a, b) => cost(a, now, by) - cost(b, now, by)))
    if (!best.has(busesOf(candidate)))
      best.set(busesOf(candidate), candidate)
  const distinct = [...best.values()]
  return distinct
    .filter(candidate => !distinct.some(other => dominates(other, candidate)))
    .slice(0, ALTERNATIVES)
}

/**
 * The bus itineraries that get there by `by`, best first: the ways `plan` would give from `now`, stepped through
 * their first buses until one is due too late, however far ahead `by` is, kept where they arrive by `by` with every
 * boarding's slack and change's spread as `scan` allows them. No bus gets to a stop earlier for a later start, so once
 * nothing is there by `by`, nothing leaving later is either. Empty when nothing makes it, which the caller says so of
 */
export const planBy = (feed: Feed, walks: Walks, runs: Run[], from: Place, to: Place, by: number, now: number): Itinerary[] => {
  // On past each first bus found, and with none to catch yet, a minute on, as long as there's time to get there by
  // `by` at all
  const candidates = candidatesOf(feed, walks, runs, from, to, now, by, (after, quickest) => {
    const next = quickest ? quickest.start + 1 : now + STEP * (Math.floor((after - now) / STEP) + 1)
    return (quickest ? quickest.end <= by : true) && next <= by ? next : undefined
  })
  return options(candidates.filter(candidate => candidate.end <= by), walks.between(from, to).meters, now, by)
}

/**
 * How long an itinerary feels from `now`, which is what options are ranked by, and with a time to be there by, the
 * time there until then, so leaving early to get there early never helps
 */
export const cost = (itinerary: Itinerary, now: number, by = itinerary.end) => {
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
    (by - itinerary.end) * EARLY_THERE +
    riding +
    walking * WALK_RELUCTANCE +
    waiting * WAIT_AT_STOP +
    Math.max(0, rides(itinerary) - 1) * TRANSFER_PENALTY
  )
}

/** The bus itineraries leaving at or after `now`, best first: the next few first buses, with and without changing */
export const plan = (feed: Feed, walks: Walks, runs: Run[], from: Place, to: Place, now: number) =>
  options(candidatesOf(feed, walks, runs, from, to, now, undefined, (_, quickest, scans) => quickest && scans < DEPARTURES ? quickest.start + 1 : undefined), walks.between(from, to).meters, now)
