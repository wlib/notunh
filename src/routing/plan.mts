// Trip planning with the Connection Scan Algorithm (https://arxiv.org/abs/1703.05997) over the day's runs as
// forecast.mts predicts them: the timetable shifted by what's known of each bus, holding at timepoints.
//
// Every boarding leaves slack for how unsure the bus's departure is. Nearer first stops are tried as well as whichever
// arrives first, so ranking can weigh walking against waiting

import { type Feed, canAlight, canBoard } from "../transit/feed.mts"
import { type Via, type Walks, walkAllowance, walkSeconds } from "./walks.mts"
import { type Run, slack, spread } from "../transit/models/forecast.mts"
import type { Place } from "../places/search.mts"

export const HORIZON = 4 * 3600      // s, how far ahead to look for buses
export const ALTERNATIVES = 3
const DEPARTURES = 6                 // first buses considered, with and without changing buses
const STEP = 60                      // s planBy looks on by where walking from a time would beat any bus
const NEARER_STOPS = 8               // first stops nearer than the quickest one's to try as well
export const MIN_TIME_SAVED = 120    // s, a bus has to feel this much better than walking now
export const MIN_TRANSFER_GAIN = 300 // s, changing buses has to do this much better than any option with fewer
export const WALK_OFFERED = 30 * 60  // s, walking the whole way is offered up to this long however the buses do

// How long an itinerary feels, relative to riding
const WALK_RELUCTANCE = 2            // walking feels twice as long
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
    meters: egress.meters[bestStop],
    via:    egress.via[bestStop]
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
  return { legs, start: leave, end: best }
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
 * The quickest ways from each of the next first buses, with and without changing: scan from `now`, then from
 * wherever `next` says to scan from given what was found, until it says to stop, and from the nearer stops each
 * could start at instead
 */
const candidatesOf = (feed: Feed, walks: Walks, runs: Run[], from: Place, to: Place, now: number, until: number, next: (after: number, quickest: Itinerary | undefined, scans: number) => number | undefined) => {
  const connections = buildConnections(runs, now, until)
  const nearest = nearerStops(walks, from)
  const candidates: Itinerary[] = []
  for (const direct of [true, false]) {
    let after: number | undefined = now
    for (let scans = 1; after !== undefined; scans++) {
      const quickest = scan(feed, walks, runs, connections, from, to, after, { now, direct })
      if (quickest) {
        candidates.push(quickest)
        const meters = (quickest.legs[0] as WalkLeg).meters
        for (const [access] of nearest.filter(([, walk]) => walk < meters).slice(0, NEARER_STOPS)) {
          const nearer = scan(feed, walks, runs, connections, from, to, after, { now, direct, access })
          if (nearer)
            candidates.push(nearer)
        }
      }
      after = next(after, quickest, scans)
    }
  }
  return candidates
}

/** One option per set of buses, whichever is best by `better` */
const distinctBy = (candidates: Itinerary[], better: (a: Itinerary, b: Itinerary) => boolean) => {
  const best = new Map<string, Itinerary>()
  for (const candidate of candidates) {
    const key = busesOf(candidate)
    if (!best.has(key) || better(candidate, best.get(key)!))
      best.set(key, candidate)
  }
  return [...best.values()]
}

/**
 * The best bus itineraries that get there by `by`, latest start first: the options `plan` would give from `now`,
 * stepped through their first buses until one is due too late, however far ahead `by` is, kept where they arrive by
 * `by` with every boarding's slack and change's spread as `scan` allows them, feel better than walking so as to be
 * there then, where walking is an offer at all, and only change buses to leave well after anything simpler. `scan`'s
 * arrival never gets earlier for a later start, so the latest start that still arrives in time is exact, once a bus
 * beats walking from the start scanned from, which a bus that leaves later may where one leaving now doesn't.
 * Walking the whole way is left to the caller, as `walkBy`. Empty when nothing makes it, which the caller says so of
 */
export const planBy = (feed: Feed, walks: Walks, runs: Run[], from: Place, to: Place, by: number, now: number): Itinerary[] => {
  // A walk too long to offer isn't weighed: being there early costs more than waiting at home, so to a `by` far
  // enough past the last bus it would beat that bus, which then couldn't be shown either
  const walk = walkBy(walks, from, to, by)
  const offered = isWalkOffered(walk.end - walk.start) ? walk : undefined
  // On past each first bus found, and where walking from here would beat any bus, which a bus leaving later may
  // yet, a minute on, as long as there's time to get there by `by` at all
  const candidates = candidatesOf(feed, walks, runs, from, to, now, Math.max(now + HORIZON, by), (after, quickest) => {
    const next = quickest ? quickest.start + 1 : now + STEP * (Math.floor((after - now) / STEP) + 1)
    return (quickest ? quickest.end <= by : true) && next <= by ? next : undefined
  }).filter(candidate => candidate.end <= by)
  const options = betterThanWalking(distinctBy(candidates, (a, b) => a.start > b.start || (a.start === b.start && cost(a, now, by) < cost(b, now, by))), offered, now, by)
  return worthChanging(options, offered ? [...candidates, offered] : candidates, option => option.start)
    .sort((a, b) => b.start - a.start || cost(a, now, by) - cost(b, now, by))
    .slice(0, ALTERNATIVES)
}

export const rides = (itinerary: Itinerary) =>
  itinerary.legs.filter(leg => leg.kind === "ride").length

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

/** The bus itineraries that feel better than walking the whole way by MIN_TIME_SAVED, as plan and planBy both ask, or all of them with no walk to weigh */
const betterThanWalking = (candidates: Itinerary[], walk: Itinerary | undefined, now: number, by?: number) =>
  walk ? candidates.filter(option => cost(option, now, by) < cost(walk, now, by) - MIN_TIME_SAVED) : candidates

/**
 * The options that change buses to some purpose: each has to be MIN_TRANSFER_GAIN better, by `value`, than anything
 * among `simpler` with fewer buses, which is to arrive sooner leaving now and to leave later for a time to be there
 * by. Walking the whole way, where it's weighed, is the simplest of all
 */
const worthChanging = (options: Itinerary[], simpler: Itinerary[], value: (itinerary: Itinerary) => number) => {
  const bestWith = (count: number) =>
    Math.max(...simpler.filter(itinerary => rides(itinerary) <= count).map(value))
  return options.filter(option => rides(option) === 1 || value(option) >= bestWith(rides(option) - 1) + MIN_TRANSFER_GAIN)
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
  const walk = walkOnly(walks, from, to, now)
  const candidates = candidatesOf(feed, walks, runs, from, to, now, now + HORIZON, (_, quickest, scans) => quickest && scans < DEPARTURES ? quickest.start + 1 : undefined)
  const options = betterThanWalking(distinctBy(candidates, (a, b) => cost(a, now) < cost(b, now)), walk, now)
  return worthChanging(options, [...candidates, walk], option => -option.end)
    .sort((a, b) => cost(a, now) - cost(b, now))
    .slice(0, ALTERNATIVES)
}
