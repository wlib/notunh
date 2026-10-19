// What a day of raw fixes shows each bus doing: going through stops, having come from the stop before, and laying
// over between trips, as the location model (locate.mts) has it along its route, each time a distribution. Trips
// come from Umo's tag on each fix, which is the timetable's trip id. These visits are what the Worker keeps long
// after the fixes are pruned, but the fixes themselves are the record, archived whole every night, and visits are
// only one reading of them: each names the extractor that read it, and another can read the fixes again

import { tripBase, type Feed, type Trip } from "./feed.mts"
import { LOOP_GAP, positionsOf, routeLines } from "./shapes.mts"
import { type Passage, passagesOf } from "./locate.mts"
import type { BusFix } from "./raw.mts"

/**
 * The version of how visits are read from fixes: 1 was zone crossings, before 2026-10-20, 2 the location model, and
 * 3 the location model with what's uncertain fitted as likelihoods
 */
export const EXTRACTOR = 3

// Longer at a stop, or between the end of one trip and the start of the next, is a bus out of service
const MAX_VISIT = 1800      // s
// Longer without a report, there's no telling what it did
const MAX_SILENCE = 120_000 // ms
// Further ahead of its timetable, a bus joining a trip partway is on its way to where it starts
const MAX_EARLY = 900       // s

/** What's known of a visit beyond its times: it was last seen still there. Its spread says how sure its times are */
export const INCOMPLETE = 2

/** A bus going through a stop, all times in epoch seconds, as the timetable's are compared in */
export type Visit = {
  vehicle: string,
  route:   string,
  stop:    string,
  /** When it got there, or stopped for it, and left, as medians */
  arrive:  number,
  depart:  number,
  /** The 10th and 90th percentiles of arrive and of depart */
  spread?: number[],
  /** How likely it stopped there, rather than going straight through */
  dwelled?: number,
  /** INCOMPLETE, and before extractor 3, 1 where it was in a gap between fixes */
  flags?:  number,
  /** The trip it left on, when the timetable has it */
  trip?:   string,
  /** Its position within that trip's stops */
  position?: number,
  /** The trip's first or last stop, where a bus lays over rather than stops */
  isEnd?:  boolean,
  /** When the timetable has it leaving */
  scheduled?: number,
  /** The stop it drove here from, the meters along its route between them, and when it left that one */
  from?:   string,
  meters?: number,
  left?:   number,
  /** Of the drive from there, the share of its time it took to get a quarter, half, and three quarters of the way */
  profile?: number[],
  /** At the first stop of a trip, when it got in at the end of the one before */
  gotIn?:  number,
  /** Umo's predicted departure, as sampled at each of the model's LEADS before it left */
  umo?:    (number | null)[],
  /** Which extractor read it, EXTRACTOR, or 1 where none is named */
  extractor?: number
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

/** One bus's visits on one route, from its fixes in order */
const extractRun = (feed: Feed, trips: ReadonlyMap<string, Trip>, fixes: readonly BusFix[], visits: Visit[]) => {
  const { vehicle, route } = fixes[0]
  const lines = routeLines(feed).get(route!)
  if (!lines)
    return
  const stopId = (trip: Trip, position: number) => feed.stops[trip.stops[position]].id
  const tripOf = (tag: string | null) => tag === null ? undefined : trips.get(tag)

  // The trip it's on, when its times count from, and the position it last left
  let run: { trip: Trip, base: number | undefined, position: number } | undefined
  // The trip it last got to the end of, and when
  let ended: { trip: Trip, at: number } | undefined
  // When it went quiet for long, after which there's no saying it laid over
  const silences = fixes.flatMap((fix, i) => i && fix.at - fixes[i - 1].at > MAX_SILENCE ? [fix.at / 1000] : [])
  let last = -Infinity

  const visit = (passage: Passage, before: Passage | undefined) => {
    const [arrive, depart] = [passage.arrive.median, passage.depart.median]
    if (silences.some(at => at > last && at <= depart))
      ended = undefined
    last = depart
    if (depart - arrive > MAX_VISIT) {
      run = ended = undefined
      return
    }
    const stop = passage.stop
    // The trip it came in on, from the last fix before it got there, and the one it left on, from the last before it
    // left, unless that trip ends here, when the one after it left may have moved on to the next
    const tagAt = (ms: number) => tripOf(fixes[Math.max(0, firstAfter(fixes, ms) - 1)].trip)
    const coming = tagAt(arrive * 1000)
    const leaving = tagAt(depart * 1000)
    const after = leaving && stopId(leaving, leaving.stops.length - 1) !== stop
      ? leaving
      : tripOf(fixes[Math.min(fixes.length - 1, firstAfter(fixes, depart * 1000))].trip) ?? leaving
    // Umo may already have it on the next trip as it gets in, so the trip it was being followed on counts too. A tag
    // switched before the last stop still loses the layover
    const finished = [run?.trip, coming].find(trip => trip && stopId(trip, trip.stops.length - 1) === stop)
    if (finished)
      ended = { trip: finished, at: arrive }
    const gotIn =
      after && ended && after !== ended.trip && stopId(after, 0) === stop && depart - ended.at <= MAX_VISIT
        ? ended.at
        : undefined
    if (gotIn !== undefined)
      ended = undefined

    // Driven from the stop before, along the same track
    const isDriven = before && before.line === passage.line && before.index === passage.index - 1 && !before.isIncomplete
    const flags = passage.isIncomplete ? INCOMPLETE : 0
    const seen: Visit = {
      vehicle,
      route: route!,
      stop,
      arrive,
      depart,
      spread:  [passage.arrive.low, passage.arrive.high, passage.depart.low, passage.depart.high],
      dwelled: passage.dwelled,
      ...flags && { flags },
      ...isDriven && {
        from:   before.stop,
        meters: passage.distance - before.distance,
        left:   before.depart.median,
        ...passage.profile && { profile: passage.profile }
      },
      ...gotIn !== undefined && { gotIn },
      extractor: EXTRACTOR
    }
    if (after && after !== run?.trip)
      run = { trip: after, base: tripBase(feed, after, depart), position: -1 }
    if (!after || !run) {
      visits.push(seen)
      return
    }
    // Along the trip from where it was, from the start on joining it where it starts, as a late bus may be due back
    // there nearer the time, or else wherever it's due nearest the time, unless it'd be far early there
    const { base, position: previous } = run
    // Where the trip has the stop along the shape it went through it on, as a loop may pass one stop twice, and
    const { line } = passage
    const along = line.coordinates === feed.shapes[after.shape] ? positionsOf(feed, after) : undefined
    const apart = (p: number) => {
      const off = along![p] - passage.distance
      return line.isLoop ? Math.abs(((off % line.length) + line.length * 1.5) % line.length - line.length / 2) : Math.abs(off)
    }
    // there, the same place as the line has it, which merges a stop at both ends of a loop
    const positions = after.stops.flatMap((_, p) => stopId(after, p) === stop && (!along || apart(p) < LOOP_GAP) ? [p] : [])
    const position =
      previous >= 0 || base === undefined || positions[0] === 0
        ? positions.find(p => p > previous)
        : positions
          .filter(p => base + after.times[p] - depart <= MAX_EARLY)
          .sort((a, b) => Math.abs(base + after.times[a] - depart) - Math.abs(base + after.times[b] - depart))[0]
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

  const observations = fixes.map(fix => ({ at: fix.at / 1000, lat: fix.lat, lon: fix.lon, heading: fix.heading, kph: fix.kph }))
  for (const track of passagesOf(lines, observations))
    track.forEach((passage, i) => visit(passage, track[i - 1]))
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
    // A bus put on another route starts afresh
    let start = 0
    for (let i = 1; i <= sorted.length; i++)
      if (i === sorted.length || sorted[i].route !== sorted[start].route) {
        extractRun(feed, trips, sorted.slice(start, i), visits)
        start = i
      }
  }
  return visits
}
