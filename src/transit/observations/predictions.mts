// A live source's word on the buses out now, as forecasting (models/forecast.mts) reads it whatever the source:
// umo.mts makes it of Umo's predictions

import { getOrCreate } from "../../shared/group.mts"
import type { PredictionSample } from "./raw.mts"

/** A live source's word on a trip: when a bus is expected at a stop, from the bus itself or from the source's own schedule */
export type Observation = {
  tripId:    string,
  stopId:    string,
  /** Epoch seconds */
  time:      number,
  vehicleId: string,
  /** The bus is on this trip, rather than the source predicting from its schedule before it starts it */
  isLive:    boolean
}

/**
 * What a live source says of the buses out now: its observations, when it gave them, in epoch seconds, and up to
 * when it covers each route at each stop it answered for, by route id and then stop id, within which a run due
 * there that it doesn't mention isn't coming. A source covers only what it answered for, so a far look ahead at
 * one stop says nothing of another
 */
export type Forecast = { observations: Observation[], at: number, coverage: Map<string, Map<string, number>> }

export const NO_FORECAST: Forecast = { observations: [], at: -Infinity, coverage: new Map() }

/** A source's word on a bus at a stop, as umo.mts reads it live and raw.mts stores it: epoch seconds, and null for no trip */
export type Predicted = { route: string, stop: string, vehicle: string, trip: string | null, time: number, isLive: boolean }

/**
 * A source's predictions as a forecast given at an epoch second. One without a trip can't say which runs it's of, so
 * it says nothing of which aren't coming
 */
export const forecastFrom = (predicted: Iterable<Predicted>, at: number): Forecast => {
  const forecast: Forecast = { observations: [], at, coverage: new Map() }
  for (const { route, stop, vehicle, trip, time, isLive } of predicted) {
    if (!trip)
      continue
    const stops = getOrCreate(forecast.coverage, route, () => new Map<string, number>())
    stops.set(stop, Math.max(stops.get(stop) ?? -Infinity, time))
    forecast.observations.push({ tripId: trip, stopId: stop, time, vehicleId: vehicle, isLive })
  }
  return forecast
}

/**
 * A stored sample of predictions (raw.mts) as the forecast the map would have had from it: given when the sample
 * was all in, or failing that when its minute began, as rows from before polls were recorded say no more
 */
export const forecastOfSample = ({ at, received, predictions }: PredictionSample) =>
  forecastFrom(predictions.map(({ at, isLayover, ...rest }) => ({ ...rest, time: at / 1000, isLive: !isLayover })), (received ?? at) / 1000)
