// The clock and live data: Umo's buses and predictions, the buses as the map follows them, and the day's runs as
// forecast from them. Reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import { isServiceActive } from "../../transit/feed.mts"
import { type Vehicle, type StopPredictions, STALE_VEHICLE_SECONDS, fetchVehicles, fetchPredictions, forecastOf } from "../../transit/observations/umo.mts"
import { NO_FORECAST } from "../../transit/observations/predictions.mts"
import { buildRuns } from "../../transit/models/forecast.mts"
import { type Fixed, drawing, follow } from "./following.mts"
import type { MapData } from "./data.mts"
import { live, poll } from "../../shell/poll.mts"
import { TICK_MS, now as clock, today, visibleSince } from "../../shell/lifecycle.mts"
import { type Own, distinct, isSameList } from "../../shell/state.mts"

const VEHICLE_POLL_MS    = 5_000
const PREDICTION_POLL_MS = 30_000
// Predictions older than this, from a poll that's been failing, say nothing about where buses are now
const PREDICTIONS_FRESH_MS = 3 * PREDICTION_POLL_MS

/** Live data for the map's bundled timetable and model, polled while the page is in view. own is given what stops it */
export const createLive = ({ feed, model }: MapData, own: Own) => {
  /** The shell's clock in epoch seconds, as the planner compares it with the timetable */
  const now = r(() => clock.value / 1000)

  const runningToday = r(() =>
    new Set(
      feed.value.trips
        .filter(trip => isServiceActive(feed.value.services[trip.service], today.value))
        .map(trip => trip.route)
    )
  )

  /** Umo's vehicles as last listed, and how asking for them is going */
  const listed = live<Vehicle[]>()
  own(poll(fetchVehicles, VEHICLE_POLL_MS, state => listed.value = state))
  /** Every vehicle as Umo last listed it */
  const reports = r(() => listed.value.value ?? [])
  /** Epoch milliseconds of the last successful vehicles update */
  const lastUpdate = r(() => listed.value.received)
  /** Umo's predictions as last answered, for the routes with a bus out */
  const asked = live<StopPredictions[]>()
  /** What Umo forecasts while its predictions are fresh, and nothing once they've gone stale, so the schedule stands in */
  const forecast = r(() => {
    const { value, received } = asked.value
    return value && received !== undefined && clock.value - received <= PREDICTIONS_FRESH_MS ? forecastOf(value, received / 1000) : NO_FORECAST
  })

  /** Seconds since a vehicle reported, as of an epoch millisecond, counting on from when Umo said so */
  const ageOf = (vehicle: Vehicle, at: number) =>
    vehicle.secsSinceReport + Math.max(0, at - (lastUpdate.value ?? at)) / 1000

  /**
   * Milliseconds Umo has gone unheard while we've been listening, which is only while the page is in view, so
   * coming back gives it a moment to answer before anything is given up on
   */
  const silence = r(() =>
    visibleSince.value === undefined
      ? 0
      : clock.value - Math.max(lastUpdate.value ?? -Infinity, visibleSince.value)
  )

  /**
   * Whether Umo has failed to answer from the start, or stopped answering for a while since we've been looking. It
   * stays set until Umo answers again, so going away and coming back doesn't forget it
   */
  const isLiveDown = r(false)
  own(watch(() => {
    if (lastUpdate.value === undefined ? listed.value.isFailing : silence.value > 3 * VEHICLE_POLL_MS + TICK_MS)
      isLiveDown.value = true
  }))
  own(watch([listed], () => {
    if (!listed.value.isFailing && listed.value.received !== undefined)
      isLiveDown.value = false
  }))

  /**
   * Buses still reporting. The rest are parked or off duty, and drop off as they age, even when Umo can't be reached,
   * though only once it's had a chance to answer. Only a change in which buses those are reaches what depends on them
   */
  const vehicles = distinct(() => {
    // Silence is negative for a moment on coming back, before the clock catches up
    const unheard = Math.max(0, silence.value) / 1000
    return reports.value.filter(vehicle =>
      (isLiveDown.value ? ageOf(vehicle, clock.value) : vehicle.secsSinceReport + unheard) < STALE_VEHICLE_SECONDS
    )
  }, isSameList)

  /** Live buses on routes in the timetable, which are the ones drawn on the map, by route */
  const liveCounts = r(() => {
    const counts = new Map<string, number>()
    for (const { route } of vehicles.value)
      if (route && feed.value.routesById.has(route.id))
        counts.set(route.id, (counts.get(route.id) ?? 0) + 1)
    return counts
  })

  // Predictions only matter for routes with a bus out; the schedule covers the rest
  const predictionPairs = r(() => [
    ...new Map(
      feed.value.trips.flatMap(trip =>
        // Nothing departs a trip's last stop
        trip.stops.slice(0, -1).map(stop => {
          const pair = { route: trip.route, stop: feed.value.stops[stop].id }
          return [`${pair.route}:${pair.stop}`, pair] as const
        })
      )
    ).values()
  ])

  // Keyed by the sorted route ids, so that a new bus going out refreshes right away, and nothing else does
  const liveRoutes = distinct(() => [...liveCounts.value.keys()].sort().join(" "))

  /**
   * Settled once Umo has answered for the buses and, with any out, for their predictions, or can't be reached, so a
   * trip planned then is as live as it's going to be
   */
  const heard = new Promise<void>(resolve => {
    const stop = watch(() => {
      const isAnswered = listed.value.received !== undefined && (asked.value.received !== undefined || asked.value.isFailing || !liveRoutes.value)
      if (isAnswered || isLiveDown.value) {
        resolve()
        queueMicrotask(stop)
      }
    })
    own(stop)
  })

  own(watch([liveRoutes, predictionPairs], () => {
    const routes = new Set(liveRoutes.value.split(" "))
    const pairs = predictionPairs.value.filter(pair => routes.has(pair.route))
    if (!pairs.length) {
      asked.value = { isFailing: false }
      return
    }
    return poll(signal => fetchPredictions(pairs, signal), PREDICTION_POLL_MS, state => asked.value = state)
  }))

  /** Every bus with the one you're on where your phone puts it, when riding.mts has it there */
  const fused = r<Fixed[]>()
  /** The buses as the map follows them, where the location model has them */
  const { followed, sightings, stop } = follow(feed, model, r(() => fused.value ?? vehicles.value))
  own(stop)

  const runs = r(() => buildRuns(feed.value, today.value, forecast.value, model.value, sightings.value))
  /** The buses as the map draws them, each along its course */
  const drawn = drawing(model, followed, runs)

  return { now, runningToday, lastUpdate, forecast, ageOf, isLiveDown, heard, vehicles, liveCounts, fused, followed, sightings, runs, drawn }
}
