// The buses the map follows. Each one's fixes go through the location model and its pace
// (src/transit/models/tracking.mts), which forecasting chains its course from (live.mts). This holds up as the
// timetable and the model are swapped for newer ones

import { r, watch, type Reactive } from "bruh/reactive"
import type { Feed } from "../../transit/feed.mts"
import type { Vehicle } from "../../transit/observations/umo.mts"
import { type Trajectory, courseAlong } from "../../transit/models/movement.mts"
import type { Model } from "../../transit/models/model.mts"
import type { Run } from "../../transit/models/forecast.mts"
import { type Tracked, fleet, sightingOf } from "../../transit/models/tracking.mts"

/** A fix as the map gets it: Umo's, or your phone's while you're riding the bus, which says how sure it is */
export type Fixed = Vehicle & { accuracy?: number }

/** A bus as last reported, with where on its route the location model has it (if it's on its route), and how it's been driving */
export type Followed = Tracked & { vehicle: Fixed }

/** A bus as the map draws it: followed, and moving along its course from where it was */
export type Drawn = Followed & { course?: Trajectory }

export const follow = (feed: Reactive<Feed>, model: Reactive<Model>, vehicles: Reactive<Fixed[]>) => {
  // Only what the fixes say survives a change of timetable or model. Under a newer timetable, buses are followed afresh
  // along its lines from their last fix, as its lines may run otherwise. Under a newer model, buses keep where they
  // are, but their paces start afresh, as they were measured against the old model's legs
  let buses = fleet(feed.peek())
  let [lastFeed, lastModel] = [feed.peek(), model.peek()]

  const followed = r<ReadonlyMap<string, Followed>>(new Map())
  const stop = watch(() => {
    const [isNewFeed, isNewModel] = [feed.value !== lastFeed, model.value !== lastModel]
    lastFeed = feed.peek()
    lastModel = model.peek()
    if (isNewFeed)
      buses = fleet(lastFeed)
    else if (isNewModel)
      buses.rebase()
    const next = new Map<string, Followed>()
    for (const vehicle of vehicles.value) {
      const tracked = buses.observe(lastModel, {
        vehicle: vehicle.id, route: vehicle.route?.id ?? null, at: vehicle.gpsTime / 1000, lat: vehicle.lat, lon: vehicle.lon, heading: vehicle.heading, kph: vehicle.kph, accuracy: vehicle.accuracy
      })
      if (!tracked)
        continue
      // A bus followed no further keeps its object, so its course is drawn once (drawing)
      const previous = followed.peek().get(vehicle.id)
      next.set(vehicle.id, previous && previous.location === tracked.location && previous.pace === tracked.pace && previous.slow === tracked.slow ? previous : { vehicle, ...tracked })
    }
    followed.value = next
  })

  /** Each bus on a trip, at the stop it's at or last left and how far it's got from there, as forecasting chains from */
  const sightings = r(() => [...followed.value.values()].flatMap(bus =>
    sightingOf(bus.vehicle.id, bus.vehicle.tripTag, bus) ?? []
  ))

  return { followed, sightings, stop }
}

/**
 * Each bus as the map draws it: along the course forecasting chained it along, where that's along the line the bus is
 * on, else along its line with no trip to wait for
 */
export const drawing = (model: Reactive<Model>, followed: Reactive<ReadonlyMap<string, Followed>>, runs: Reactive<Run[]>) => {
  // A bus followed anew, or by a newer model, is a new object, so its course along its line is drawn once for each
  const along = new WeakMap<Followed, Trajectory | undefined>()
  const alongOf = (bus: Followed) => {
    if (!along.has(bus))
      along.set(bus, bus.location && courseAlong(model.peek(), bus.location, bus.pace, bus.slow))
    return along.get(bus)
  }
  return r(() => {
    const chained = new Map(runs.value.flatMap(({ vehicle, tracked }) => vehicle && tracked ? [[vehicle, tracked.trajectory]] : []))
    return new Map([...followed.value].map(([id, bus]): [string, Drawn] => {
      const forecast = chained.get(id)
      return [id, { ...bus, course: forecast && forecast.line === bus.location?.line ? forecast : alongOf(bus) }]
    }))
  })
}
