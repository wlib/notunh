// Umo's own predictions every 5 minutes, for routes with a bus out, so a learned forecast can be scored against them.
// The stops come from Umo's route config rather than the bundled feed, which would cost the Worker its CPU to load

import { STALE_VEHICLE_SECONDS, fetchPredictions, fetchRouteStops, fetchVehicles } from "../src/map/umo.mts"
import { packPredictions, type RawPrediction } from "../src/map/raw.mts"
import { HEADERS, type Source } from "./collect.mts"

export const predictions: Source<RawPrediction> = {
  name: "predictions",
  cron: "*/5 * * * *",
  collect: async (at, signal) => {
    const routes = new Set(
      (await fetchVehicles(signal, HEADERS))
        .filter(vehicle => vehicle.route && vehicle.secsSinceReport <= STALE_VEHICLE_SECONDS)
        .map(vehicle => vehicle.route!.id)
    )
    const pairs = await Promise.all(
      [...routes].map(async route =>
        (await fetchRouteStops(route, signal, HEADERS)).map(stop => ({ route, stop: stop.id }))
      )
    )
    return pairs.length
      ? packPredictions(at, await fetchPredictions(pairs.flat(), signal, HEADERS))
      : []
  }
}
