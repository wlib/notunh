// Following buses a fix at a time, as the map does live (src/map/state/following.mts), and as the nightly scoring
// and the reminders' Worker replay from stored fixes (sightingsFrom): each fix through the location model
// (locate.mts), which says where along its route a bus is and which stops it's been through, and its pace from the
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

/** Whether a fix of a bus is news against the one it was last followed by: newer, as Umo sometimes sends an older fix after a newer one, or on another route */
const isNews = (last: { at: number, route?: string | null } | undefined, fix: { at: number, route: string }) =>
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

/** A fix of a bus, whichever source gave it: Umo's listing, your phone's while riding, or a stored sample */
export type Fix = Observation & { vehicle: string, route: string | null }

/** Where the location model has a bus, if it's on its route, and how it's been driving */
export type Tracked = { location?: Location, pace: Pace }

/**
 * The buses followed along a timetable's lines, a fix at a time, by one rule for the map live, the nightly scoring's
 * replay and the reminders' Worker: a fix that isn't news of its bus changes nothing, a bus put on another route
 * starts afresh there, as the nightly extraction treats it too, and a fix off every route of the lines is passed over
 */
export const fleet = (feed: Feed) => {
  // The lines are read at the first fix, as the map's state is made before anything of the timetable is needed
  let lines: ReturnType<typeof routeLines> | undefined
  const buses = new Map<string, { route: string, bus: ReturnType<typeof busOn>, at: number, tracked: Tracked }>()
  return {
    /** Follows a fix: where its bus is now, which is the same object as before unless the fix was news, or undefined for a fix off the lines */
    observe: (model: Model, fix: Fix): Tracked | undefined => {
      lines ??= routeLines(feed)
      if (fix.route === null || !lines.has(fix.route))
        return undefined
      let own = buses.get(fix.vehicle)
      if (own && !isNews(own, { at: fix.at, route: fix.route }))
        return own.tracked
      if (own?.route !== fix.route)
        buses.set(fix.vehicle, own = { route: fix.route, bus: busOn(lines.get(fix.route)!), at: fix.at, tracked: { pace: NO_PACE } })
      own.at = fix.at
      own.tracked = own.bus.observe(model, fix)
      return own.tracked
    },
    /** Every bus's pace forgotten, as when the model they were measured against is replaced */
    rebase: () => {
      for (const own of buses.values()) {
        own.bus.rebase()
        own.tracked = { ...own.tracked, pace: NO_PACE }
      }
    }
  }
}

/**
 * What the map would have seen of the buses at any epoch second, asked in increasing order, from their stored fixes.
 * Each fix is fed through the fleet once the Worker's poll received it, in the order received, as the map gets them
 * (fixes without a receipt time are taken as received when taken), and a bus's trip is as its last fix followed had
 * it tagged
 */
export const sightingsFrom = (feed: Feed, model: Model, fixes: readonly BusFix[]) => {
  const buses = fleet(feed)
  const got = (fix: BusFix) => fix.received ?? fix.at
  const sorted = fixes.toSorted((a, b) => got(a) - got(b) || a.at - b.at)
  const seen = new Map<string, { tracked: Tracked, sighting?: Sighting }>()
  let next = 0
  return (at: number): Sighting[] => {
    for (; next < sorted.length && got(sorted[next]) <= at * 1000; next++) {
      const fix = sorted[next]
      const tracked = buses.observe(model, { vehicle: fix.vehicle, route: fix.route, at: fix.at / 1000, lat: fix.lat, lon: fix.lon, heading: fix.heading, kph: fix.kph })
      if (tracked && tracked !== seen.get(fix.vehicle)?.tracked)
        seen.set(fix.vehicle, { tracked, sighting: sightingOf(fix.vehicle, fix.trip, tracked.location, tracked.pace) })
    }
    // A bus not heard from in a while is out of service
    return [...seen.values()].flatMap(({ sighting }) => sighting && sighting.at >= at - OUT_OF_SERVICE ? [sighting] : [])
  }
}
