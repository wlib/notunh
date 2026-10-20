import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { flush, r } from "bruh/reactive"
import type { Map as MapLibre } from "maplibre-gl"
import { serviceDayStart, withIndexes } from "../../src/transit/feed.mts"
import { type Coordinates, ruler } from "../../src/geo/projection.mts"
import { pointAt } from "../../src/geo/lines.mts"
import { lineOf } from "../../src/transit/shapes.mts"
import type { Visit } from "../../src/transit/inference/events.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { update } from "../../src/transit/models/fit.mts"
import { buildRuns } from "../../src/transit/models/forecast.mts"
import { type Fixed, drawing, follow } from "../../src/map/state/following.mts"
import { animateBuses, confidence } from "../../src/map/render/buses.mts"
import { addDays } from "../../src/shared/time.mts"

const TODAY = "2026-10-01"
const BASE = serviceDayStart(TODAY) / 1000
const [LAT, LON] = [43.135, -70.93]
const EAST = ruler(LAT).kx
const east = (meters: number): Coordinates => [LON + meters / EAST, LAT]

// Route R's stops a kilometer apart along a street running east, its one trip leaving each six minutes after the last
const feed = withIndexes({
  version: "test",
  start: "2000-01-01",
  end: "2099-12-31",
  routes: [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
  stops: [0, 1, 2, 3].map(i => ({ id: `${i}`, name: `Stop ${i}`, lat: LAT, lon: east(i * 1000)[0] })),
  services: { daily: { days: 127, start: "2000-01-01", end: "2099-12-31", added: [], removed: [] } },
  trips: [{ id: "T0", route: "R", service: "daily", headsign: "", shape: "S", timepoints: [], stops: [0, 1, 2, 3], times: [0, 1, 2, 3].map(i => 36000 + i * 360) }],
  shapes: { S: Array.from({ length: 31 }, (_, i) => east(i * 100)) }
})
const line = lineOf(feed, feed.trips[0])!

/** A model that's seen buses take only a minute between stops */
const quick = update(emptyModel(), addDays(TODAY, -1), Array.from({ length: 5 }, (_, i): Visit[] => [0, 1, 2].map(stop => ({
  vehicle: `V${i}`, route: "R", stop: `${stop + 1}`, arrive: BASE + 36060, depart: BASE + 36070, from: `${stop}`, meters: 1000, left: BASE + 36000
}))).flat())

/** The bus reporting from some meters along the street, driving east at 10 m/s, at an epoch second, listed 5 s later */
const fix = (meters: number, at: number): Fixed => {
  const [lon, lat] = east(meters)
  return { id: "V", lat, lon, gpsTime: at * 1000, secsSinceReport: 5, heading: 90, kph: 36, route: { id: "R" }, dir: null, tripTag: "T0" }
}

test("confidence is full for a fresh report, fades as it ages, and never fades away", () => {
  fc.assert(fc.property(fc.double({ min: -60, max: 3600, noNaN: true }), fc.double({ min: 0, max: 3600, noNaN: true }), (age, more) => {
    expect(confidence(age + more)).toBeLessThanOrEqual(confidence(age))
    expect(confidence(age)).toBeGreaterThanOrEqual(0.3)
    expect(confidence(age)).toBeLessThanOrEqual(1)
  }))
  expect(confidence(0)).toBe(1)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("a bus is drawn along its forecast's course, and a newer model's course for the same fix is drawn as soon as it's eased into", () => {
  const T0 = BASE + 36360
  vi.useFakeTimers({ toFake: ["Date"] })
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (frame = callback, 0))
  let drawnAt: Coordinates | undefined
  const map = { getSource: () => ({ setData: ({ features }: GeoJSON.FeatureCollection<GeoJSON.Point>) => drawnAt = features[0]?.geometry.coordinates as Coordinates }) }

  const [feedNow, model, vehicles] = [r(feed), r(emptyModel()), r<Fixed[]>([])]
  const { followed, sightings } = follow(feedNow, model, vehicles)
  const runs = r(() => buildRuns(feedNow.value, TODAY, undefined, model.value, sightings.value))
  const drawn = drawing(model, followed, runs)
  animateBuses(map as unknown as MapLibre, feedNow, drawn, r({}))
  const listed = (fixed: Fixed) => {
    vi.setSystemTime(fixed.gpsTime + 5000)
    vehicles.value = [fixed]
    flush()
  }
  const render = (at: number) => {
    vi.setSystemTime(at * 1000)
    frame!(at * 1000)
  }

  // Seen either side of stop 1, which it went straight through
  listed(fix(900, T0 - 10))
  listed(fix(1100, T0 + 10))
  const bus = drawn.value.get("V")!
  const { trajectory } = runs.value.find(run => run.vehicle === "V" && run.tracked)!.tracked!
  expect(bus.course).toBe(trajectory)
  expect(bus.course!.line).toBe(line)
  const where = (at: number) => {
    const { course, from } = drawn.value.get("V")!.course!
    return pointAt(line, from + course.distanceAt(Math.min(at, T0 + 10 + 45))).point
  }
  render(T0 + 25)
  expect(drawnAt![0]).toBeCloseTo(where(T0 + 25)[0], 9)

  // Only the model changes: the fix is the same object, and its new course is drawn once eased into
  const before = where(T0 + 30)
  vi.setSystemTime((T0 + 28) * 1000)
  model.value = quick
  flush()
  expect(drawn.value.get("V")!.vehicle).toBe(bus.vehicle)
  expect(drawn.value.get("V")!.course).not.toBe(bus.course)
  expect(where(T0 + 30)[0]).toBeGreaterThan(before[0] + 20 / EAST)
  render(T0 + 30)
  expect(drawnAt![0]).toBeCloseTo(where(T0 + 30)[0], 9)
})
