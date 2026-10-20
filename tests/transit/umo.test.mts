import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { fetchPredictions, fetchVehicles } from "../../src/transit/observations/umo.mts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const pair = fc.record({
  route: fc.stringMatching(/^[A-Za-z0-9]{1,10}$/),
  stop:  fc.stringMatching(/^[0-9]{1,4}$/)
})

test("whatever Umo answers, fetchVehicles gives only vehicles with a fix, or fails as a load does, saying it was unexpected", () =>
  fc.assert(fc.asyncProperty(fc.oneof(fc.array(fc.oneof(fc.jsonValue(), fc.record({ id: fc.string(), lat: fc.double(), lon: fc.double(), gpsTime: fc.integer(), secsSinceReport: fc.integer() }))), fc.jsonValue()), async body => {
    vi.stubGlobal("fetch", async () => Response.json(body))
    const vehicles = fetchVehicles()
    if (!Array.isArray(body))
      await expect(vehicles).rejects.toThrow("Unexpected JSON")
    else
      for (const { id, lat, lon, gpsTime } of await vehicles)
        expect([typeof id, typeof lat, typeof lon, typeof gpsTime]).toEqual(["string", "number", "number", "number"])
  }))
)

test("a prediction with a time and a bus is kept whatever else it lacks, as the Worker stores no more of it", async () => {
  const prediction = { timestamp: 1_760_000_000_000, vehicleId: "1201", affectedByLayover: false }
  vi.stubGlobal("fetch", async () => Response.json([{ route: { id: "3B" }, stop: { id: "12" }, values: [prediction, { ...prediction, vehicleId: 7 }] }]))
  expect(await fetchPredictions([{ route: "3B", stop: "12" }])).toEqual([{ route: { id: "3B" }, stop: { id: "12" }, values: [prediction] }])
})

test("fetchPredictions asks for every pair, in order, in URLs the API accepts", async () =>
  fc.assert(fc.asyncProperty(fc.array(pair, { maxLength: 400 }), async pairs => {
    const urls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url)
      return new Response("[]")
    })

    await fetchPredictions(pairs)

    for (const url of urls)
      expect(url.length).toBeLessThanOrEqual(1024)
    const requested = urls.flatMap(url => url.match(/nstops\/(.*)\/predictions/)![1].split(","))
    expect(requested).toEqual(pairs.map(({ route, stop }) => `${route}:${stop}`))
  }))
)
