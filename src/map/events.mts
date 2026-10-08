// What a day of raw fixes shows each bus doing: visiting stops, having driven there from the stop before, and
// laying over between trips, found by the same snapping and zone crossing the map learns its pace by. Trips come
// from Umo's tag on each fix, which is the timetable's trip id. These visits are what the Worker keeps long after
// the fixes are pruned, so the model can be refit from them

import { tripBase, type Feed, type Trip } from "./feed.mts"
import { routeLines, snapToLines } from "./geometry.mts"
import { MIN_MOVING_KPH, cross, type Trace } from "./pace.mts"
import type { BusFix } from "./raw.mts"

// Longer at a stop, or between the end of one trip and the start of the next, is a bus out of service
const MAX_VISIT = 1800      // s
// Longer without a report, there's no telling what it did
const MAX_SILENCE = 120_000 // ms

/** A bus going through a stop's zone, all times in epoch seconds, as the timetable's are compared in */
export type Visit = {
  vehicle: string,
  route:   string,
  stop:    string,
  /** When it entered and left the zone */
  arrive:  number,
  depart:  number,
  /** The trip it left on, when the timetable has it */
  trip?:   string,
  /** Its position within that trip's stops */
  position?: number,
  /** The trip's first or last stop, where a bus lays over rather than stops */
  isEnd?:  boolean,
  /** When the timetable has it leaving */
  scheduled?: number,
  /** The stop it drove here from, the meters between their zones, and when it left that one's */
  from?:   string,
  meters?: number,
  left?:   number,
  /** At the first stop of a trip, when it got in at the end of the one before */
  gotIn?:  number,
  /** Umo's predicted departure, as sampled at each of the model's LEADS before it left */
  umo?:    (number | null)[]
}

/** The index of the first of a bus's sorted fixes after an epoch millisecond, or their count */
const firstAfter = (fixes: readonly BusFix[], ms: number) => {
  let [low, high] = [0, fixes.length]
  while (low < high) {
    const middle = (low + high) >> 1
    if (fixes[middle].at > ms)
      high = middle
    else
      low = middle + 1
  }
  return low
}

/** One bus's visits, from its fixes in order */
const extractBus = (feed: Feed, trips: ReadonlyMap<string, Trip>, fixes: readonly BusFix[], visits: Visit[]) => {
  const lines = routeLines(feed)
  const { vehicle } = fixes[0]
  const stopId = (trip: Trip, position: number) => feed.stops[trip.stops[position]].id
  const tripOf = (tag: string | null) => tag === null ? undefined : trips.get(tag)

  let trace: Trace | undefined
  // The trip it's on, when its times count from, and the position it last left
  let run: { trip: Trip, base: number | undefined, position: number } | undefined
  // The trip it last got to the end of, and when
  let ended: { trip: Trip, at: number } | undefined
  // The drive into the zone it's in
  let drive: { from: string, to: string, meters: number, start: number, end: number } | undefined

  const visit = (route: string, stop: string, arrive: number, depart: number) => {
    const driven = drive?.to === stop && drive.end === arrive ? drive : undefined
    drive = undefined
    if (depart - arrive > MAX_VISIT) {
      run = ended = undefined
      return
    }
    // The trip it came in on, from the last fix before it got there, and the one it left on, from the last before it
    // left, unless that trip ends here, when the one after it left may have moved on to the next
    const tagAt = (ms: number) => tripOf(fixes[Math.max(0, firstAfter(fixes, ms) - 1)].trip)
    const before = tagAt(arrive * 1000)
    const leaving = tagAt(depart * 1000)
    const after = leaving && stopId(leaving, leaving.stops.length - 1) !== stop
      ? leaving
      : tripOf(fixes[Math.min(fixes.length - 1, firstAfter(fixes, depart * 1000))].trip) ?? leaving
    // Umo may already have it on the next trip as it gets in, so the trip it was being followed on counts too. A tag
    // switched before the last stop still loses the layover
    const finished = [run?.trip, before].find(trip => trip && stopId(trip, trip.stops.length - 1) === stop)
    if (finished)
      ended = { trip: finished, at: arrive }
    const gotIn =
      after && ended && after !== ended.trip && stopId(after, 0) === stop && depart - ended.at <= MAX_VISIT
        ? ended.at
        : undefined
    if (gotIn !== undefined)
      ended = undefined

    const seen: Visit = {
      vehicle,
      route,
      stop,
      arrive,
      depart,
      ...driven && { from: driven.from, meters: driven.meters, left: driven.start },
      ...gotIn !== undefined && { gotIn }
    }
    if (after && after !== run?.trip)
      run = { trip: after, base: tripBase(feed, after, depart), position: -1 }
    if (!after || !run) {
      visits.push(seen)
      return
    }
    // Along the trip from where it was, from the start on joining it where it starts, as a late bus may be due back
    // there nearer the time, or else wherever it's due nearest the time
    const { base, position: last } = run
    const positions = after.stops.flatMap((_, p) => stopId(after, p) === stop ? [p] : [])
    const position =
      last >= 0 || base === undefined || positions[0] === 0
        ? positions.find(p => p > last)
        : positions.sort((a, b) => Math.abs(base + after.times[a] - depart) - Math.abs(base + after.times[b] - depart))[0]
    if (position === undefined) {
      visits.push(seen)
      return
    }
    run.position = position
    visits.push({
      ...seen,
      trip:  after.id,
      position,
      isEnd: position === 0 || position === after.stops.length - 1,
      ...base !== undefined && { scheduled: base + after.times[position] }
    })
  }

  let [route, at]: [string | null, number] = [null, -Infinity]
  for (const fix of fixes) {
    const routeLinesOf = fix.route === null ? undefined : lines.get(fix.route)
    // A bus put on another route starts afresh, and one gone quiet for a while can't be said to have laid over
    if (fix.route !== route)
      trace = run = ended = drive = undefined
    if (fix.at - at > MAX_SILENCE)
      ended = undefined
    route = fix.route
    at = fix.at
    if (!routeLinesOf)
      continue
    const isMoving = fix.kph !== null && fix.kph >= MIN_MOVING_KPH
    const track = snapToLines(routeLinesOf, fix, isMoving ? fix.heading ?? undefined : undefined, trace?.track)
    // Off its route, it could be anywhere until it's back
    if (!track) {
      trace = drive = undefined
      continue
    }
    const crossed = cross(trace, track, fix.at / 1000, !isMoving)
    trace = crossed.trace
    for (const crossing of crossed.crossings)
      if (crossing.kind === "drive")
        drive = crossing
      else
        visit(fix.route!, crossing.stop, crossing.arrive, crossing.depart)
  }
}

/** Every bus's visits to stops in some fixes, each bus's in order */
export const extract = (feed: Feed, fixes: readonly BusFix[]) => {
  const trips = new Map(feed.trips.map(trip => [trip.id, trip]))
  const byVehicle = new Map<string, BusFix[]>()
  for (const fix of fixes) {
    const own = byVehicle.get(fix.vehicle)
    if (own)
      own.push(fix)
    else
      byVehicle.set(fix.vehicle, [fix])
  }

  const visits: Visit[] = []
  for (const vehicle of [...byVehicle.keys()].sort()) {
    // A fix polled twice across a minute boundary is stored in both minutes
    const sorted = byVehicle.get(vehicle)!
      .sort((a, b) => a.at - b.at)
      .filter((fix, i, all) => i === 0 || fix.at !== all[i - 1].at)
    extractBus(feed, trips, sorted, visits)
  }
  return visits
}
