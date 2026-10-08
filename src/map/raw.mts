// What the Worker keeps of the live API, one row per source per minute, and how anything reads it back.
// Rows hold tuples rather than objects to keep the Worker's stringify cheap and the gzip small; ids repeat
// across a minute's fixes and gzip takes care of that without a dictionary

import type { StopPredictions, Vehicle } from "./umo.mts"

/** A vehicle's fix as stored, at seconds relative to the start of the row's minute */
export type RawFix = [
  vehicle: string,
  at:      number,
  lat:     number,
  lon:     number,
  heading: number | null,
  kph:     number | null,
  trip:    string | null,
  route:   string | null,
  /** The stop Umo has it at, only while it's there */
  stop:    string | null
]

/** A vehicle's next arrival or departure at a stop as stored, at seconds relative to the start of the row's minute */
export type RawPrediction = [
  route:     string,
  stop:      string,
  vehicle:   string,
  trip:      string | null,
  at:        number,
  isLayover: 0 | 1
]

export type BusFix = {
  vehicle: string,
  /** Epoch milliseconds the bus took the fix */
  at:      number,
  lat:     number,
  lon:     number,
  heading: number | null,
  kph:     number | null,
  trip:    string | null,
  route:   string | null,
  stop:    string | null
}

export type SampledPrediction = {
  route:     string,
  stop:      string,
  vehicle:   string,
  trip:      string | null,
  /** Epoch milliseconds Umo expects the bus */
  at:        number,
  /** The bus hadn't started the trip, so this was Umo's schedule rather than a forecast */
  isLayover: boolean
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const isString = (value: unknown): value is string =>
  typeof value === "string"

const numberOrNull = (value: unknown) =>
  isNumber(value) ? value : null

const stringOrNull = (value: unknown) =>
  isString(value) ? value : null

// Each row is at the epoch millisecond its minute starts
const relative = (at: number, ms: number) =>
  (ms - at) / 1000

const absolute = (at: number, seconds: number) =>
  at + Math.round(seconds * 1000)

/** Every vehicle with a usable fix, and nothing for one without, so a change upstream stores less rather than garbage */
export const packFixes = (at: number, vehicles: readonly Vehicle[]): RawFix[] =>
  vehicles
    .filter(vehicle => isString(vehicle?.id) && isNumber(vehicle.gpsTime) && isNumber(vehicle.lat) && isNumber(vehicle.lon))
    .map(vehicle => [
      vehicle.id,
      relative(at, vehicle.gpsTime),
      vehicle.lat,
      vehicle.lon,
      numberOrNull(vehicle.heading),
      numberOrNull(vehicle.kph),
      stringOrNull(vehicle.tripTag),
      stringOrNull(vehicle.route?.id),
      vehicle.vehiclePosition?.atCurrentStop === true ? stringOrNull(vehicle.vehiclePosition.currentStopTag) : null
    ])

export const unpackFixes = (at: number, body: readonly RawFix[]): BusFix[] =>
  body.map(([vehicle, seconds, lat, lon, heading, kph, trip, route, stop]) =>
    ({ vehicle, at: absolute(at, seconds), lat, lon, heading, kph, trip, route, stop })
  )

/** Only the soonest prediction for each route, stop, and vehicle, which is all a later forecast can be scored against */
export const packPredictions = (at: number, entries: readonly StopPredictions[]): RawPrediction[] => {
  const soonest = new Map<string, RawPrediction>()
  for (const { route, stop, values } of entries)
    for (const { vehicleId, tripId, timestamp, affectedByLayover } of values ?? []) {
      if (!isString(route?.id) || !isString(stop?.id) || !isString(vehicleId) || !isNumber(timestamp))
        continue
      const key = `${route.id}:${stop.id}:${vehicleId}`
      const seconds = relative(at, timestamp)
      const current = soonest.get(key)
      if (!current || seconds < current[4])
        soonest.set(key, [route.id, stop.id, vehicleId, stringOrNull(tripId), seconds, affectedByLayover ? 1 : 0])
    }
  return [...soonest.values()]
}

export const unpackPredictions = (at: number, body: readonly RawPrediction[]): SampledPrediction[] =>
  body.map(([route, stop, vehicle, trip, seconds, isLayover]) =>
    ({ route, stop, vehicle, trip, at: absolute(at, seconds), isLayover: isLayover === 1 })
  )

const pipe = (bytes: BodyInit, stream: CompressionStream | DecompressionStream) =>
  new Response(new Response(bytes).body!.pipeThrough(stream))

/** A row's body: gzipped JSON */
export const encode = async (samples: readonly unknown[]) =>
  new Uint8Array(await pipe(JSON.stringify(samples), new CompressionStream("gzip")).arrayBuffer())

export const decode = async <T,>(body: Uint8Array<ArrayBuffer>): Promise<T[]> =>
  JSON.parse(await pipe(body, new DecompressionStream("gzip")).text())

/** A body as SQLite's hex() writes it, which is how rows travel as JSON */
export const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16))
