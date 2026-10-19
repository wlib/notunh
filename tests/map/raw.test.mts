import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { type StopPredictions, type Vehicle, fetchVehicles } from "../../src/map/umo.mts"
import { type ObservedRow, type RawFix, type RawPoll, type RawPrediction, RAW_VERSION, decode, encode, fromHex, observe, packFixes, packPoll, packPredictions, unpackFixes, unpackPredictions } from "../../src/map/raw.mts"

// The epoch millisecond a row's minute starts
const AT = 1_791_360_000_000

afterEach(() => {
  vi.unstubAllGlobals()
})

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

// Polls a minute made, each when it was made and how many it saw, if it didn't fail
const polls = fc.array(fc.tuple(fc.integer({ min: 0, max: 59_999 }), fc.option(fc.nat(20), { nil: null })), { minLength: 1, maxLength: 6 })
  .map(polls => polls.map(([ms, seen]) => packPoll(AT, AT + ms, seen)))

/** A body as an older Worker wrote it, gzipped JSON */
const gzipped = (row: unknown) =>
  new Response(new Blob([JSON.stringify(row)]).stream().pipeThrough(new CompressionStream("gzip"))).bytes()

test("unpackFixes gives back every vehicle's fix exactly, and the poll that first saw it, through a row body", async () =>
  fc.assert(fc.asyncProperty(fc.array(vehicle, { maxLength: 40 }), polls, fc.nat(), async (vehicles, polls, seed) => {
    const first = vehicles.map((_, i) => (seed + i) % polls.length)
    const body = await encode(vehicles.flatMap((vehicle, i) => packFixes(AT, [vehicle], first[i])), polls)
    const row = await decode<RawFix>(body)
    expect(row.version).toBe(RAW_VERSION)
    expect(row.polls).toEqual(polls)
    const fixes = unpackFixes(AT, row)
    expect(fixes.map(fix => fix.received)).toEqual(first.map(poll => AT + Math.round(polls[poll][0] * 1000)))
    expect(fixes.map(({ received, ...fix }) => fix)).toEqual(vehicles.map(vehicle => ({
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

test("a vehicle Umo lists without some fields is stored with nulls for them, and one with no position not at all", () =>
  fc.assert(fc.asyncProperty(vehicle, fc.subarray(["heading", "kph", "tripTag", "route", "vehiclePosition", "lat", "gpsTime"]), async (vehicle, missing) => {
    const partial = Object.fromEntries(Object.entries(vehicle).filter(([key]) => !missing.includes(key)))
    vi.stubGlobal("fetch", async () => Response.json([partial, null]))
    const packed = packFixes(AT, await fetchVehicles(), 0)
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
    const body = await encode(packPredictions(AT, entries), [packPoll(AT, AT, 3)])
    const sampled = unpackPredictions(AT, await decode<RawPrediction>(body))

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

test("rows an older Worker wrote still read, saying which version they are, and without polls or receipt", async () => {
  const fix: RawFix = ["T-51", 3.5, 43.13, -70.93, 90, 20, null, "Gables", null]
  for (const [row, version] of [[[fix], 0], [{ version: 1, samples: [fix] }, 1]] as const) {
    const read = await decode<RawFix>(await gzipped(row))
    expect(read).toEqual({ version, samples: [fix], polls: null })
    expect(unpackFixes(AT, read)).toEqual([{ vehicle: "T-51", at: AT + 3500, lat: 43.13, lon: -70.93, heading: 90, kph: 20, trip: null, route: "Gables", stop: null }])
  }
})

test("a row of a later version, or not a row at all, is refused rather than misread", async () => {
  for (const row of [{ version: RAW_VERSION + 1, samples: [], polls: [] }, { version: RAW_VERSION, samples: [] }, { samples: [] }, "fixes"])
    await expect(decode(await gzipped(row))).rejects.toThrow("reads up to")
})

test("observing rows gives every fix and prediction in the order of their minutes, and each source's polls, or the minutes that didn't record them", () =>
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({ minute: fc.nat(30), source: fc.constantFrom("buses" as const, "predictions" as const), polls: fc.option(polls, { nil: null }) }), { selector: ({ minute, source }) => `${minute} ${source}` }),
    rows => {
      const at = (minute: number) => AT + minute * 60_000
      const fix = (minute: number): RawFix => ["T-51", minute, 43.13, -70.93, null, null, null, null, null, 0]
      const prediction = (minute: number): RawPrediction => ["3", "101", "T-51", null, minute, 0]
      const observed: ObservedRow[] = rows.map(({ minute, source, polls }) => source === "buses"
        ? { source, at: at(minute), version: polls ? RAW_VERSION : 1, samples: [fix(minute)], polls }
        : { source, at: at(minute), version: polls ? RAW_VERSION : 1, samples: [prediction(minute)], polls })
      const { fixes, predictions, coverage } = observe(observed)
      const sorted = rows.toSorted((a, b) => a.minute - b.minute)
      const of = (source: string) => sorted.filter(row => row.source === source)
      expect(fixes.map(fix => fix.at)).toEqual(of("buses").map(({ minute }) => at(minute) + minute * 1000))
      expect(fixes.every(fix => (fix.received === undefined) === !of("buses").find(({ minute }) => at(minute) + minute * 1000 === fix.at)!.polls)).toBe(true)
      expect(predictions.map(({ at }) => at)).toEqual(of("predictions").map(({ minute }) => at(minute)))
      for (const source of ["buses", "predictions"] as const) {
        expect(coverage[source].polls).toEqual(of(source).flatMap(({ minute, polls }) =>
          (polls ?? []).map(([seconds, seen]: RawPoll) => ({ at: at(minute) + Math.round(seconds * 1000), seen }))
        ))
        expect(coverage[source].unrecorded).toEqual(of(source).filter(({ polls }) => !polls).map(({ minute }) => at(minute)))
      }
    }
  ))
)
