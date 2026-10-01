// Live data from the Umo IQ rider API, the backend behind rider.umoiq.com and the Umo apps.
// It needs no key and allows any origin. Found via https://rider.umoiq.com/appsettings -> apiPath

const BASE = "https://api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh"

/** Vehicles that haven't reported in this long are parked or off duty */
export const STALE_VEHICLE_SECONDS = 180

// The API 403s once the URL passes ~1 KB, so batched stop lists are chunked under this
const MAX_STOPS_PARAM_LENGTH = 850

export type Vehicle = {
  id:              string,
  lat:             number,
  lon:             number,
  heading:         number,
  kph:             number,
  secsSinceReport: number,
  predictable:     boolean,
  gpsTime:         number,
  route: { id: string, name: string } | null,
  dir:   { id: string, dirName: string, dirNameShort: string } | null
}

export type Prediction = {
  /** Epoch milliseconds */
  timestamp:   number,
  minutes:     number,
  vehicleId:   string,
  tripId:      string,
  isDeparture: boolean,
  /** The bus hasn't started this trip yet, so this comes from Umo's schedule */
  affectedByLayover: boolean,
  direction: { id: string, name: string, destinationName: string }
}

export type StopPredictions = {
  serverTimestamp: number,
  route: { id: string, title: string, color: string, textColor: string },
  stop:  { id: string, name: string, code: string },
  values: Prediction[]
}

const get = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(BASE + path, { signal })
  if (!response.ok)
    throw new Error(`Umo ${response.status} ${path}`)
  return response.json()
}

export const fetchVehicles = (signal?: AbortSignal) =>
  get<Vehicle[]>("/vehicles", signal)

export const fetchStopPredictions = (stopId: string, signal?: AbortSignal) =>
  get<StopPredictions[]>(`/stopcodes/${encodeURIComponent(stopId)}/predictions`, signal)

export const fetchPredictions = async (pairs: Iterable<{ route: string, stop: string }>, signal?: AbortSignal) => {
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
      .map(chunk => get<StopPredictions[]>(`/nstops/${chunk.join(",")}/predictions`, signal))
  )
  return results.flat()
}
