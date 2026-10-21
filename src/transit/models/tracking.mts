// Following a bus a fix at a time, as the map does live (src/map/state/following.mts), and as the nightly scoring
// and the reminders' Worker replay from stored fixes (sightingsFrom): each fix through the location model
// (locate.mts), which says where along its route it is and which stops it's been through, and its pace from the
// legs it drove (movement.mts). Forecasting (forecast.mts) chains from the same, and nothing is learned from where a
// bus was drawn

import { type RouteLine, routeLines } from "../shapes.mts"
import type { Feed } from "../feed.mts"
import type { Observation } from "../inference/likelihoods.mts"
import { type Location, type Passage, drove } from "../inference/passages.mts"
import { locator } from "../inference/locate.mts"
import type { BusFix } from "../observations/raw.mts"
import { type Pace, NO_PACE, expectedMu, paced, whereaboutsOf } from "./movement.mts"
import type { Model } from "./model.mts"
import type { Sighting } from "./forecast.mts"

// A bus last seen at a stop longer ago than this, without leaving the route, is out of service
const OUT_OF_SERVICE = 1800 // s

/**
 * Whether a fix of a bus is news against the one it was last followed by: newer, as Umo sometimes sends an older fix
 * after a newer one, or on another route, which is news either way, as the map and the nightly scoring both take it
 */
export const isNews = (last: { at: number, route?: string | null } | undefined, fix: { at: number, route: string }) =>
  !last || fix.route !== last.route || fix.at > last.at

/** A bus's pace, having finished a leg: from the stop before along the same line, as long as the model expects, or not */
export const pacedBy = (model: Model, pace: Pace, before: Passage | undefined, passage: Passage) => {
  const seconds = drove(before, passage) && passage.arrive.median - before.depart.median
  return seconds && seconds > 0
    ? paced(pace, Math.log(seconds) - expectedMu(model, passage.line.route, before.stop, passage.stop, passage.distance - before.distance, passage.arrive.median), passage.arrive.median)
    : pace
}

/**
 * One bus followed along its route's lines, a fix at a time, as the map does live and the nightly scoring replays:
 * where the location model has it, and its pace from the legs it's finished, against a model
 */
export const busOn = (lines: readonly RouteLine[]) => {
  const locate = locator(lines)
  let pace = NO_PACE
  let last: Passage | undefined
  return {
    observe: (model: Model, fix: Observation) => {
      for (const passage of locate.observe(fix)) {
        pace = pacedBy(model, pace, last, passage)
        last = passage
      }
      return { location: locate.locate(), pace }
    },
    /** Its pace forgotten, as when the model it was measured against is replaced */
    rebase: () => {
      pace = NO_PACE
    }
  }
}

/** A bus on a trip, at the stop it's at or last left and how far it's got from there, as forecasting chains from */
export const sightingOf = (vehicleId: string, tripId: string | null | undefined, location: Location | undefined, pace: Pace): Sighting | undefined =>
  tripId && location?.last ? { vehicleId, tripId, stop: location.last.stop, ...whereaboutsOf(location).where, pace, at: location.at } : undefined

/**
 * What the map would have seen of the buses at any epoch second, asked in increasing order, from their stored fixes.
 * Each fix is fed through the location model once the Worker's poll received it, in the order received, as the map
 * gets them (fixes without a receipt time are taken as received when taken). Like the map, it passes over fixes
 * older than one already followed, and takes a bus's trip as its last fix had it tagged
 */
export const sightingsFrom = (feed: Feed, model: Model, fixes: readonly BusFix[]) => {
  const lines = routeLines(feed)
  const got = (fix: BusFix) => fix.received ?? fix.at
  const sorted = fixes.toSorted((a, b) => got(a) - got(b) || a.at - b.at)
  const buses = new Map<string, { route: string, bus: ReturnType<typeof busOn>, at: number, seen?: Sighting }>()
  let next = 0
  return (at: number): Sighting[] => {
    for (; next < sorted.length && got(sorted[next]) <= at * 1000; next++) {
      const fix = sorted[next]
      if (fix.route === null || !lines.has(fix.route))
        continue
      let own = buses.get(fix.vehicle)
      if (!isNews(own, { at: fix.at, route: fix.route }))
        continue
      if (own?.route !== fix.route)
        buses.set(fix.vehicle, own = { route: fix.route, bus: busOn(lines.get(fix.route)!), at: fix.at })
      const { location, pace } = own.bus.observe(model, { at: fix.at / 1000, lat: fix.lat, lon: fix.lon, heading: fix.heading, kph: fix.kph })
      own.at = fix.at
      own.seen = sightingOf(fix.vehicle, fix.trip, location, pace)
    }
    // A bus not heard from in a while is out of service
    return [...buses.values()].flatMap(({ seen }) => seen && seen.at >= at - OUT_OF_SERVICE ? [seen] : [])
  }
}
