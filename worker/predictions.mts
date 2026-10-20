// Umo's own predictions every 5 minutes, for routes with a bus out, so a learned forecast can be scored against them.
// The stops come from Umo's route config rather than the bundled feed, which would cost the Worker its CPU to load.
// The whole round is one poll, recorded with how many live buses it listed, or as failed if any request failed

import { STALE_VEHICLE_SECONDS, fetchPredictions, fetchRouteStops, fetchVehicles } from "../src/transit/observations/umo.mts"
import { packPoll, packPredictions, type RawPrediction } from "../src/transit/observations/raw.mts"
import { HEADERS, type Source } from "./collect.mts"

export const predictions: Source<RawPrediction> = {
  name: "predictions",
  cron: "*/5 * * * *",
  collect: async (at, signal) => {
    const made = Date.now()
    try {
      const live = (await fetchVehicles(signal, HEADERS)).filter(vehicle => vehicle.secsSinceReport <= STALE_VEHICLE_SECONDS)
      const routes = new Set(live.flatMap(vehicle => vehicle.route ? [vehicle.route.id] : []))
      const pairs = await Promise.all(
        [...routes].map(async route =>
          (await fetchRouteStops(route, signal, HEADERS)).map(stop => ({ route, stop: stop.id }))
        )
      )
      const samples = pairs.length
        ? packPredictions(at, await fetchPredictions(pairs.flat(), signal, HEADERS))
        : []
      return { samples, polls: [packPoll(at, made, live.length)] }
    }
    catch (error) {
      console.warn(error)
      return { samples: [], polls: [packPoll(at, made, null)] }
    }
  }
}
