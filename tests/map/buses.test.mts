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
import { CATCH_UP, SMOOTHING, animateBuses, confidence, smoothed } from "../../src/map/render/buses.mts"
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

/** A map and clock to draw on: the bus's drawn meters east after each frame, and the course it's drawn along */
const stage = () => {
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
  /** Renders a frame at an epoch second, and gives the bus's drawn meters along the street */
  const render = (at: number) => {
    vi.setSystemTime(Math.round(at * 1000))
    frame!(Math.round(at * 1000))
    return (drawnAt![0] - LON) * EAST
  }
  /** Where the course has the bus at an epoch second, in meters along the street */
  const modeled = (at: number) => {
    const { vehicle, course, location } = drawn.value.get("V")!
    return course ? course.from + course.course.distanceAt(Math.min(at, vehicle.gpsTime / 1000 + 45)) : location!.distance
  }
  return { model, drawn, runs, listed, render, modeled }
}

test("a bus is drawn along its forecast's course, and a newer model's course for the same fix is caught up with within seconds", () => {
  const T0 = BASE + 36360
  const { model, drawn, runs, listed, render, modeled } = stage()

  // Seen either side of stop 1, which it went straight through
  listed(fix(900, T0 - 10))
  listed(fix(1100, T0 + 10))
  const bus = drawn.value.get("V")!
  const { trajectory } = runs.value.find(run => run.vehicle === "V" && run.tracked)!.tracked!
  expect(bus.course).toBe(trajectory)
  expect(bus.course!.line).toBe(line)
  expect(render(T0 + 25)).toBeCloseTo(modeled(T0 + 25), 6)

  // Only the model changes: the fix is the same object, and its new course is further on, which the drawn bus hurries to
  const before = modeled(T0 + 30)
  vi.setSystemTime((T0 + 28) * 1000)
  model.value = quick
  flush()
  expect(drawn.value.get("V")!.vehicle).toBe(bus.vehicle)
  expect(drawn.value.get("V")!.course).not.toBe(bus.course)
  expect(modeled(T0 + 30)).toBeGreaterThan(before + 20)
  let caught: number | undefined
  for (let i = 0; i < 20 * 25 && caught === undefined; i++) {
    const at = T0 + 28 + i / 20
    if (Math.abs(render(at) - modeled(at)) < 5)
      caught = at
  }
  expect(caught).toBeDefined()
  expect(caught! - (T0 + 28)).toBeLessThan(15)
})

test("smoothed never moves a bus backwards, never slower than half the model while ahead of a moving model, never more than CATCH_UP faster while behind, and converges to a fixed model", () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 5000, noNaN: true }),
    fc.double({ min: -300, max: 300, noNaN: true }),
    fc.double({ min: 0, max: 25, noNaN: true }),
    fc.double({ min: 0.01, max: 5, noNaN: true }),
    (modeled, gap, speed, dt) => {
      const drawn = modeled + gap
      const next = smoothed(drawn, modeled, speed, dt)
      const v = (next - drawn) / dt
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(speed + CATCH_UP + 1e-6)
      if (gap > 0)
        expect(v).toBeGreaterThanOrEqual(speed / 2 - 1e-6)
      // Toward the model, never past it in a frame, and with it once there
      if (gap < 0)
        expect(next).toBeLessThanOrEqual(modeled + speed * dt + 1e-6)
      if (gap === 0)
        expect(v).toBeCloseTo(speed, 9)
    }
  ))
  // From behind a fixed model, there within a few SMOOTHING
  fc.assert(fc.property(fc.double({ min: 1, max: 2000, noNaN: true }), behind => {
    let drawn = 1000 - behind
    for (let t = 0; t < 10 * SMOOTHING + behind / CATCH_UP; t += 0.05)
      drawn = smoothed(drawn, 1000, 0, 0.05)
    expect(drawn).toBeCloseTo(1000, 1)
  }))
})

test("a bus drawn ahead of a new fix's course slows but doesn't stand while the course drives, and one behind hurries at a bus's speed and reaches the course within seconds", () => {
  const T0 = BASE + 36360
  const { listed, render, modeled } = stage()
  listed(fix(900, T0 - 10))
  listed(fix(1100, T0 + 10))
  for (let i = 0; i < 20 * 30; i++)
    render(T0 + 15 + i / 20)
  const wasDrawn = render(T0 + 44.95)

  // A fix behind where it was drawn, listed as the frames go on: the course starts there, and the drawn bus slows
  // toward it, moving whenever the course does
  listed(fix(1200, T0 + 40))
  expect(modeled(T0 + 45)).toBeLessThan(wasDrawn)
  let [previous, gap] = [wasDrawn, wasDrawn - modeled(T0 + 45)]
  for (let i = 1; i <= 20 * 25; i++) {
    const at = T0 + 45 + i / 20
    const [drawn, course] = [render(at), modeled(at)]
    expect(drawn).toBeGreaterThanOrEqual(previous - 1e-3)
    if (course > modeled(at - 0.05) + 0.01)
      expect(drawn).toBeGreaterThan(previous)
    expect(drawn - course).toBeLessThanOrEqual(gap + 1e-3)
    ;[previous, gap] = [drawn, drawn - course]
  }

  // A fix ahead: the drawn bus hurries, at most CATCH_UP over the course's speed, and is with it within seconds
  for (let i = 0; i < 20 * 5; i++)
    render(T0 + 70 + i / 20)
  const behindFrom = render(T0 + 74.95)
  listed(fix(behindFrom + 60, T0 + 70))
  expect(modeled(T0 + 75)).toBeGreaterThan(behindFrom + 30)
  let [previousAt, caught] = [T0 + 74.95, undefined as number | undefined]
  previous = behindFrom
  for (let i = 1; i <= 20 * 25; i++) {
    const at = T0 + 75 + i / 20
    const [drawn, course] = [render(at), modeled(at)]
    expect(drawn - previous).toBeLessThanOrEqual(course - modeled(previousAt) + CATCH_UP * (at - previousAt) + 1e-3)
    if (caught === undefined && Math.abs(drawn - course) < 5)
      caught = at
    ;[previous, previousAt] = [drawn, at]
  }
  expect(caught).toBeDefined()
  expect(caught! - (T0 + 75)).toBeLessThan(15)
})
