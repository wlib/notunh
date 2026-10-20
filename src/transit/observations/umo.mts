// Live data from the Umo IQ rider API, the backend behind rider.umoiq.com and the Umo apps.
// It needs no key and allows any origin. Found via https://rider.umoiq.com/appsettings -> apiPath

import * as v from "valibot"
import { getJson, usable } from "../../shared/json.mts"
import type { Forecast } from "./predictions.mts"

const BASE = "https://api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh"

/** Vehicles that haven't reported in this long are parked or off duty */
export const STALE_VEHICLE_SECONDS = 180

// The API 403s once the URL passes ~1 KB, so batched stop lists are chunked under this
const MAX_STOPS_PARAM_LENGTH = 850

// The slices of Umo's answers we read, each answer an array keeping only the items that fit, so a change upstream
// shows less rather than garbage. A vehicle needs only a fix, and a prediction only a time and a bus; what they
// know besides, they may not

const Vehicle = v.object({
  id:              v.string(),
  lat:             v.number(),
  lon:             v.number(),
  /** Epoch milliseconds of its fix */
  gpsTime:         v.number(),
  secsSinceReport: v.number(),
  heading:         v.nullish(v.number()),
  kph:             v.nullish(v.number()),
  route:           v.nullish(v.object({ id: v.string() })),
  dir:             v.nullish(v.object({ dirNameShort: v.string() })),
  /** The GTFS trip it's running, like "3B FULL_T04" */
  tripTag:         v.nullish(v.string()),
  /** Umo's own placing of it along its trip */
  vehiclePosition: v.nullish(v.object({
    /** The stop it's at or last passed */
    currentStopTag: v.nullish(v.string()),
    atCurrentStop:  v.optional(v.boolean())
  }))
})
export type Vehicle = v.InferOutput<typeof Vehicle>

const Prediction = v.object({
  /** Epoch milliseconds */
  timestamp:         v.number(),
  vehicleId:         v.string(),
  tripId:            v.nullish(v.string()),
  /** The bus hasn't started this trip yet, so this comes from Umo's schedule */
  affectedByLayover: v.boolean()
})
export type Prediction = v.InferOutput<typeof Prediction>

const StopPredictions = v.object({
  route:  v.object({ id: v.string() }),
  stop:   v.object({ id: v.string() }),
  values: v.optional(usable(Prediction), [])
})
export type StopPredictions = v.InferOutput<typeof StopPredictions>

/**
 * Umo's predictions, as answered at an epoch second, as a forecast (predictions.mts). Each prediction with a trip is
 * an observation of that trip at the stop, live unless Umo is predicting from its schedule before the bus starts the
 * trip. The latest time predicted at each of a route's stops is how far ahead Umo covers it there
 */
export const forecastOf = (predictions: readonly StopPredictions[], at: number): Forecast => {
  const forecast: Forecast = { observations: [], at, coverage: new Map() }
  for (const { route, stop, values } of predictions)
    for (const { timestamp, vehicleId, tripId, affectedByLayover } of values) {
      // One without a trip can't say which runs it's of, so it says nothing of which aren't coming
      if (!tripId)
        continue
      const time = timestamp / 1000
      const stops = forecast.coverage.get(route.id) ?? forecast.coverage.set(route.id, new Map()).get(route.id)!
      stops.set(stop.id, Math.max(stops.get(stop.id) ?? -Infinity, time))
      forecast.observations.push({ tripId, stopId: stop.id, time, vehicleId, isLive: !affectedByLayover })
    }
  return forecast
}

/** One of a route's stops, as Umo's route config lists them */
const RouteStop = v.object({ id: v.string() })

// Browsers send their own User-Agent, while the Worker has to send one or Umo answers 403, so only it passes headers
const get = <T,>(path: string, schema: v.GenericSchema<unknown, T>, signal?: AbortSignal, headers?: HeadersInit) =>
  getJson(BASE + path, { schema, signal, headers })

export const fetchVehicles = (signal?: AbortSignal, headers?: HeadersInit) =>
  get("/vehicles", usable(Vehicle), signal, headers)

export const fetchRouteStops = (routeId: string, signal?: AbortSignal, headers?: HeadersInit) =>
  get(`/routes/${encodeURIComponent(routeId)}/stops`, usable(RouteStop), signal, headers)

export const fetchPredictions = async (pairs: Iterable<{ route: string, stop: string }>, signal?: AbortSignal, headers?: HeadersInit) => {
  const chunks: string[][] = [[]]
  let length = 0
  for (const { route, stop } of pairs) {
    const key = `${encodeURIComponent(route)}:${encodeURIComponent(stop)}`
    if (length + key.length > MAX_STOPS_PARAM_LENGTH) {
      chunks.push([])
      length = 0
    }
    chunks.at(-1)!.push(key)
    length += key.length + 1
  }

  const results = await Promise.all(
    chunks
      .filter(chunk => chunk.length)
      .map(chunk => get(`/nstops/${chunk.join(",")}/predictions`, usable(StopPredictions), signal, headers))
  )
  return results.flat()
}
