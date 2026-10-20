// Following a bus a fix at a time, as the map does live (src/map/state/following.mts) and the nightly scoring
// replays: each fix through the location model (locate.mts), which says where along its route it is and which
// stops it's been through, and its pace from the legs it drove (movement.mts). Forecasting (forecast.mts) chains
// from the same, and nothing is learned from where a bus was drawn

import type { RouteLine } from "../shapes.mts"
import { type Location, type Observation, type Passage, locator, stopDistance } from "../inference/locate.mts"
import { type Pace, NO_PACE, expectedMu, paced } from "./movement.mts"
import type { Model } from "./model.mts"
import type { Sighting } from "./forecast.mts"

/**
 * Whether a fix of a bus is news against the one it was last followed by: newer, as Umo sometimes sends an older fix
 * after a newer one, or on another route, which is news either way, as the map and the nightly scoring both take it
 */
export const isNews = (last: { at: number, route?: string | null } | undefined, fix: { at: number, route: string }) =>
  !last || fix.route !== last.route || fix.at > last.at

/** A bus's pace, having finished a leg: from the stop before along the same line, as long as the model expects, or not */
export const pacedBy = (model: Model, pace: Pace, before: Passage | undefined, passage: Passage) => {
  const isLeg = before && before.line === passage.line && before.index === passage.index - 1 && !before.isIncomplete
  const seconds = isLeg && passage.arrive.median - before.depart.median
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
export const sightingOf = (vehicleId: string, tripId: string | null | undefined, location: Location | undefined, pace: Pace): Sighting | undefined => {
  const last = location?.last
  if (!tripId || !location || !last)
    return
  const meters = stopDistance(location.line, last.index + 1) - last.distance
  return {
    vehicleId,
    tripId,
    stop:   last.stop,
    arrive: last.arrive,
    ...location.mode !== "dwelling" && {
      depart:   last.depart ?? location.since,
      progress: Number.isFinite(meters) && meters > 0 ? (location.distance - last.distance) / meters : 0,
      speed:    location.speed,
      ...location.mode === "halted" && { halted: location.since }
    },
    pace,
    at: location.at
  }
}
