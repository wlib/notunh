import { test, expect } from "vitest"
import fc from "fast-check"
import type { StopPredictions, Vehicle } from "../../src/map/umo.mts"
import { decode, encode, fromHex, packFixes, packPredictions, unpackFixes, unpackPredictions } from "../../src/map/raw.mts"

// The epoch millisecond a row's minute starts
const AT = 1_791_360_000_000

const id = fc.stringMatching(/^[A-Za-z0-9 _-]{1,12}$/)

const vehicle = fc.record({
  id,
  lat:             fc.double({ min: 43, max: 43.3, noNaN: true }),
  lon:             fc.double({ min: -71, max: -70.7, noNaN: true }),
  heading:         fc.integer({ min: 0, max: 359 }),
  kph:             fc.integer({ min: 0, max: 100 }),
  secsSinceReport: fc.integer({ min: 0, max: 600 }),
  predictable:     fc.boolean(),
  // Within a couple of minutes either side of the row's, to the millisecond
  gpsTime:         fc.integer({ min: AT - 120_000, max: AT + 120_000 }),
  route:           fc.option(fc.record({ id, name: id }), { nil: null }),
  dir:             fc.constant(null),
  tripTag:         fc.option(id, { nil: undefined }),
  vehiclePosition: fc.option(fc.record({ currentStopTag: id, atCurrentStop: fc.boolean() }), { nil: undefined })
}) satisfies fc.Arbitrary<Vehicle>

const prediction = fc.record({
  timestamp:         fc.integer({ min: AT, max: AT + 3_600_000 }),
  minutes:           fc.integer({ min: 0, max: 60 }),
  vehicleId:         fc.constantFrom("T-51", "T-53", "T-60"),
  tripId:            id,
  isDeparture:       fc.boolean(),
  affectedByLayover: fc.boolean(),
  direction:         fc.constant({ id: "", name: "", destinationName: "" })
})

const stopPredictions = fc.record({
  serverTimestamp: fc.constant(AT),
  route:           fc.constantFrom("3", "Gables").map(id => ({ id, title: id, color: "", textColor: "" })),
  stop:            fc.constantFrom("101", "148").map(id => ({ id, name: id, code: id })),
  values:          fc.array(prediction, { maxLength: 6 })
}) satisfies fc.Arbitrary<StopPredictions>

test("unpackFixes gives back every vehicle's fix exactly, through a row body", async () =>
  fc.assert(fc.asyncProperty(fc.array(vehicle, { maxLength: 40 }), async vehicles => {
    const body = await encode(packFixes(AT, vehicles))
    const fixes = unpackFixes(AT, await decode(body))
    expect(fixes).toEqual(vehicles.map(vehicle => ({
      vehicle: vehicle.id,
      at:      vehicle.gpsTime,
      lat:     vehicle.lat,
      lon:     vehicle.lon,
      heading: vehicle.heading,
      kph:     vehicle.kph,
      trip:    vehicle.tripTag ?? null,
      route:   vehicle.route?.id ?? null,
      stop:    vehicle.vehiclePosition?.atCurrentStop ? vehicle.vehiclePosition.currentStopTag : null
    })))
  }))
)

test("packFixes stores nulls for missing fields, and nothing for a vehicle with no position, never throwing", () =>
  fc.assert(fc.property(vehicle, fc.subarray(["heading", "kph", "tripTag", "route", "vehiclePosition", "lat", "gpsTime"]), (vehicle, missing) => {
    const partial = Object.fromEntries(Object.entries(vehicle).filter(([key]) => !missing.includes(key))) as Vehicle
    const packed = packFixes(AT, [partial, null as unknown as Vehicle])
    if (missing.includes("lat") || missing.includes("gpsTime")) {
      expect(packed).toEqual([])
      return
    }
    expect(packed).toHaveLength(1)
    for (const [key, index] of [["heading", 4], ["kph", 5], ["tripTag", 6], ["route", 7], ["vehiclePosition", 8]] as const)
      if (missing.includes(key))
        expect(packed[0][index]).toBeNull()
  }))
)

test("packPredictions keeps exactly the soonest prediction for each route, stop, and vehicle", async () =>
  fc.assert(fc.asyncProperty(fc.array(stopPredictions, { maxLength: 8 }), async entries => {
    const body = await encode(packPredictions(AT, entries))
    const sampled = unpackPredictions(AT, await decode(body))

    const all = entries.flatMap(({ route, stop, values }) => values.map(value => ({ route: route.id, stop: stop.id, ...value })))
    const key = ({ route, stop, vehicle }: { route: string, stop: string, vehicle: string }) => `${route}:${stop}:${vehicle}`
    expect(new Set(sampled.map(key)).size).toBe(sampled.length)
    expect(new Set(sampled.map(key))).toEqual(new Set(all.map(({ vehicleId, ...rest }) => key({ ...rest, vehicle: vehicleId }))))
    for (const sample of sampled) {
      const candidates = all.filter(value => key({ ...value, vehicle: value.vehicleId }) === key(sample))
      const soonest = Math.min(...candidates.map(({ timestamp }) => timestamp))
      expect(sample.at).toBe(soonest)
      expect(candidates.some(value => value.timestamp === soonest && value.tripId === sample.trip && value.affectedByLayover === sample.isLayover)).toBe(true)
    }
  }))
)

test("fromHex reads what SQLite's hex() writes", () =>
  fc.assert(fc.property(fc.uint8Array({ maxLength: 100 }), bytes => {
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join("")
    expect(fromHex(hex)).toEqual(bytes)
  }))
)
