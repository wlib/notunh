// A live source's word on the buses out now, as forecasting (models/forecast.mts) reads it whatever the source:
// umo.mts makes it of Umo's predictions

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
