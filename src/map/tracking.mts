// The buses the map follows: each one's fixes through the location model (locate.mts), which says where along its
// route it is and which stops it's been through, its pace from the legs it drove (movement.mts), and its course
// from there, which is where it's drawn (buses.mts). Forecasting (forecast.mts) chains from the same, and nothing
// is learned from where a bus was drawn

import { r, watch, type Reactive } from "bruh/reactive"
import { tripBase, type Feed } from "./feed.mts"
import type { Vehicle } from "./umo.mts"
import { type RouteLine, routeLines } from "./shapes.mts"
import { type Location, type Observation, type Passage, locator, stopDistance } from "./locate.mts"
import { type Course, type Pace, NO_PACE, courseAlong, expectedMu, paced } from "./movement.mts"
import { holdChances, isLikely, type Model } from "./model.mts"
import type { Sighting } from "./forecast.mts"

/** A fix as the map gets it: Umo's, or your phone's while you're riding the bus, which says how sure it is */
export type Fixed = Vehicle & { accuracy?: number }

/**
 * A bus as last reported, where on its route the location model has it, if it's on its route, how it's been
 * driving, and its course from there, drawn from the meters along its line its way starts at
 */
export type Followed = { vehicle: Fixed, location?: Location, pace: Pace, course?: { course: Course, from: number } }

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

export const follow = (feed: Reactive<Feed>, model: Reactive<Model>, vehicles: Reactive<Fixed[]>) => {
  const trips = r(() => new Map(feed.value.trips.map(trip => [trip.id, trip])))

  /**
   * When a bus's trip is scheduled to leave the stops it waits at when early, between its first and last, which on a
   * loop are the same stop, where waiting is a layover
   */
  const holdsOf = (vehicle: Vehicle) => {
    const trip = vehicle.tripTag ? trips.peek().get(vehicle.tripTag) : undefined
    const base = trip && tripBase(feed.peek(), trip, vehicle.gpsTime / 1000)
    if (!trip || base === undefined)
      return
    const chances = holdChances(model.peek(), feed.peek(), trip)
    return new Map(trip.stops.flatMap((stop, position) =>
      position > 0 && position < trip.stops.length - 1 && isLikely(chances[position]) ? [[feed.peek().stops[stop].id, base + trip.times[position]] as const] : []
    ))
  }

  // Each bus, on its route's lines: a newer timetable's buses are followed along its lines from their next fix, and
  // a newer model's paces start afresh, as they were measured against the old one's legs
  let buses = new Map<string, { route: string, bus: ReturnType<typeof busOn> }>()
  watch([feed], () => {
    buses = new Map()
  })
  watch([model], () => {
    for (const { bus } of buses.values())
      bus.rebase()
  })

  const followed = r<ReadonlyMap<string, Followed>>(new Map())
  watch(() => {
    const linesByRoute = routeLines(feed.peek())
    const next = new Map<string, Followed>()
    for (const vehicle of vehicles.value) {
      const route = vehicle.route?.id
      if (!route || !linesByRoute.has(route))
        continue
      const previous = followed.peek().get(vehicle.id)
      // Umo sometimes sends an older fix after a newer one, though a bus put on another route is news either way
      if (previous && vehicle.gpsTime <= previous.vehicle.gpsTime && previous.vehicle.route?.id === route) {
        next.set(vehicle.id, previous)
        continue
      }
      let own = buses.get(vehicle.id)
      // A bus put on another route starts afresh, as the nightly extraction has it
      if (own?.route !== route) {
        own = { route, bus: busOn(linesByRoute.get(route)!) }
        buses.set(vehicle.id, own)
      }
      const { location, pace } = own.bus.observe(model.peek(), {
        at: vehicle.gpsTime / 1000, lat: vehicle.lat, lon: vehicle.lon, heading: vehicle.heading, kph: vehicle.kph, accuracy: vehicle.accuracy
      })
      next.set(vehicle.id, { vehicle, location, pace, course: location && courseAlong(model.peek(), location, pace, holdsOf(vehicle)) })
    }
    followed.value = next
  })

  /** Each bus on a trip, at the stop it's at or last left and how far it's got from there, as forecasting chains from */
  const sightings = r(() => [...followed.value.values()].flatMap(({ vehicle, location, pace }) =>
    sightingOf(vehicle.id, vehicle.tripTag, location, pace) ?? []
  ))

  return { followed, sightings }
}
