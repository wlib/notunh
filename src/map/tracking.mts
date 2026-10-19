// The buses the map follows: each one's latest fix snapped onto its route, what it did at the stops between fixes,
// and how it's been driving (pace.mts). Drawing them (buses.mts) and forecasting them (forecast.mts) both read this,
// and learn nothing from where a bus was drawn

import { r, watch, type Reactive } from "bruh/reactive"
import { tripBase, type Feed } from "./feed.mts"
import type { Vehicle } from "./umo.mts"
import { snapToLines } from "../geo/follow.mts"
import { BUS_TRACKING, routeLines } from "./shapes.mts"
import { MIN_MOVING_KPH, type Trace } from "./crossings.mts"
import { NO_PACE, createLately, observe } from "./pace.mts"
import { holdChances, isLikely, type Model } from "./model.mts"
import type { Sighting } from "./forecast.mts"

/** A bus as last reported, and where on its route that put it, if it's on its route */
export type Followed = { vehicle: Vehicle, trace?: Trace }

export const follow = (feed: Reactive<Feed>, model: Reactive<Model>, vehicles: Reactive<Vehicle[]>) => {
  // A newer timetable's buses are followed along its lines from their next fix, and a newer model's start afresh
  const trips = r(() => new Map(feed.value.trips.map(trip => [trip.id, trip])))
  /** What every bus has shown of how long stretches and stops take, shared by all of them */
  const lately = r(() => createLately(model.value))

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

  const followed = r<ReadonlyMap<string, Followed>>(new Map())
  watch(() => {
    const linesByRoute = routeLines(feed.peek())
    const next = new Map<string, Followed>()
    for (const vehicle of vehicles.value) {
      if (!vehicle.route || !feed.peek().routesById.has(vehicle.route.id))
        continue
      const previous = followed.peek().get(vehicle.id)
      // Umo sometimes sends an older fix after a newer one, though a bus put on another route is news either way
      if (previous && vehicle.gpsTime <= previous.vehicle.gpsTime && previous.vehicle.route?.id === vehicle.route.id) {
        next.set(vehicle.id, previous)
        continue
      }
      // Speed is too rough to drive by, but tells a moving bus from a stopped one, whose heading means nothing
      const isMoving = (vehicle.kph ?? 0) >= MIN_MOVING_KPH
      const track = snapToLines(linesByRoute.get(vehicle.route.id)!, vehicle, isMoving ? vehicle.heading ?? undefined : undefined, previous?.trace?.track, BUS_TRACKING)
      next.set(vehicle.id, {
        vehicle,
        trace: track && { ...observe(lately.peek(), previous?.trace, track, vehicle.gpsTime / 1000, !isMoving), holds: holdsOf(vehicle) }
      })
    }
    followed.value = next
  })

  /** Each bus on a trip, at the stop it's at or last left, as forecasting chains from */
  const sightings = r(() => [...followed.value.values()].flatMap(({ vehicle, trace }): Sighting[] =>
    vehicle.tripTag && trace?.seen
      ? [{ vehicleId: vehicle.id, tripId: vehicle.tripTag, ...trace.seen, pace: trace.pace ?? NO_PACE, at: vehicle.gpsTime / 1000 }]
      : []
  ))

  return { lately, followed, sightings }
}
