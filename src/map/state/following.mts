// The buses the map follows. Each one's fixes go through the location model and its pace
// (src/transit/models/tracking.mts), and its course from there is where it's drawn (render/buses.mts). This holds up
// as the timetable and the model are swapped for newer ones

import { r, watch, type Reactive } from "bruh/reactive"
import { tripBase, type Feed } from "../../transit/feed.mts"
import type { Vehicle } from "../../transit/observations/umo.mts"
import { routeLines } from "../../transit/shapes.mts"
import type { Location } from "../../transit/inference/locate.mts"
import { type Course, type Pace, NO_PACE, courseAlong } from "../../transit/models/movement.mts"
import type { Model } from "../../transit/models/model.mts"
import { holdChances, isLikely } from "../../transit/models/estimates.mts"
import { busOn, isNews, sightingOf } from "../../transit/models/tracking.mts"

/** A fix as the map gets it: Umo's, or your phone's while you're riding the bus, which says how sure it is */
export type Fixed = Vehicle & { accuracy?: number }

/**
 * A bus as last reported, with where on its route the location model has it (if it's on its route), how it's been
 * driving, and its course from there. `from` is the meters along its line the course starts at
 */
export type Followed = { vehicle: Fixed, location?: Location, pace: Pace, course?: { course: Course, from: number } }

export const follow = (feed: Reactive<Feed>, model: Reactive<Model>, vehicles: Reactive<Fixed[]>) => {
  const trips = r(() => new Map(feed.value.trips.map(trip => [trip.id, trip])))

  /**
   * By stop id, the epoch seconds a bus's trip is scheduled to leave each stop it likely waits at when early. The
   * first and last stops are left out: on a loop they're the same stop, and waiting there is a layover
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

  /** A bus as followed, from where it is and its pace, with its course drawn by the model */
  const followedAs = (vehicle: Fixed, location: Location | undefined, pace: Pace): Followed =>
    ({ vehicle, location, pace, course: location && courseAlong(model.peek(), location, pace, holdsOf(vehicle)) })

  // Each bus on its route's lines, and the timetable and model it was last followed by. Only what the fixes say
  // survives a change of either. Under a newer timetable, buses are followed afresh along its lines from their last
  // fix, as its lines may run otherwise. Under a newer model, buses keep where they are, but their paces start afresh,
  // as they were measured against the old model's legs, and their courses are redrawn by the new one
  let buses = new Map<string, { route: string, bus: ReturnType<typeof busOn> }>()
  let [lastFeed, lastModel] = [feed.peek(), model.peek()]

  const followed = r<ReadonlyMap<string, Followed>>(new Map())
  watch(() => {
    const [isNewFeed, isNewModel] = [feed.value !== lastFeed, model.value !== lastModel]
    lastFeed = feed.peek()
    lastModel = model.peek()
    if (isNewFeed)
      buses = new Map()
    else if (isNewModel)
      for (const { bus } of buses.values())
        bus.rebase()
    const linesByRoute = routeLines(feed.peek())
    const next = new Map<string, Followed>()
    for (const vehicle of vehicles.value) {
      const route = vehicle.route?.id
      if (!route || !linesByRoute.has(route))
        continue
      const previous = followed.peek().get(vehicle.id)
      let own = buses.get(vehicle.id)
      if (previous && own?.route === route && !isNews({ at: previous.vehicle.gpsTime, route: previous.vehicle.route?.id }, { at: vehicle.gpsTime, route })) {
        next.set(vehicle.id, isNewModel ? followedAs(vehicle, previous.location, NO_PACE) : previous)
        continue
      }
      // A bus put on another route starts afresh, as the nightly extraction treats it too
      if (own?.route !== route) {
        own = { route, bus: busOn(linesByRoute.get(route)!) }
        buses.set(vehicle.id, own)
      }
      const { location, pace } = own.bus.observe(model.peek(), {
        at: vehicle.gpsTime / 1000, lat: vehicle.lat, lon: vehicle.lon, heading: vehicle.heading, kph: vehicle.kph, accuracy: vehicle.accuracy
      })
      next.set(vehicle.id, followedAs(vehicle, location, pace))
    }
    followed.value = next
  })

  /** Each bus on a trip, at the stop it's at or last left and how far it's got from there, as forecasting chains from */
  const sightings = r(() => [...followed.value.values()].flatMap(({ vehicle, location, pace }) =>
    sightingOf(vehicle.id, vehicle.tripTag, location, pace) ?? []
  ))

  return { followed, sightings }
}
