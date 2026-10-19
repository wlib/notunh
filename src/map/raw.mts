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

// Each row is at the epoch millisecond its minute starts
const relative = (at: number, ms: number) =>
  (ms - at) / 1000

const absolute = (at: number, seconds: number) =>
  at + Math.round(seconds * 1000)

/** Every vehicle's fix, with null for whatever else Umo didn't say of it */
export const packFixes = (at: number, vehicles: readonly Vehicle[]): RawFix[] =>
  vehicles.map(vehicle => [
    vehicle.id,
    relative(at, vehicle.gpsTime),
    vehicle.lat,
    vehicle.lon,
    vehicle.heading ?? null,
    vehicle.kph ?? null,
    vehicle.tripTag ?? null,
    vehicle.route?.id ?? null,
    vehicle.vehiclePosition?.atCurrentStop === true ? vehicle.vehiclePosition.currentStopTag ?? null : null
  ])

export const unpackFixes = (at: number, body: readonly RawFix[]): BusFix[] =>
  body.map(([vehicle, seconds, lat, lon, heading, kph, trip, route, stop]) =>
    ({ vehicle, at: absolute(at, seconds), lat, lon, heading, kph, trip, route, stop })
  )

/** Only the soonest prediction for each route, stop, and vehicle, which is all a later forecast can be scored against */
export const packPredictions = (at: number, entries: readonly StopPredictions[]): RawPrediction[] => {
  const soonest = new Map<string, RawPrediction>()
  for (const { route, stop, values } of entries)
    for (const { vehicleId, tripId, timestamp, affectedByLayover } of values) {
      const key = `${route.id}:${stop.id}:${vehicleId}`
      const seconds = relative(at, timestamp)
      const current = soonest.get(key)
      if (!current || seconds < current[4])
        soonest.set(key, [route.id, stop.id, vehicleId, tripId ?? null, seconds, affectedByLayover ? 1 : 0])
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
