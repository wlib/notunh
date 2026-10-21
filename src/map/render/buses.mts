// Buses drawn where we expect them to be now. Each moves along its course (movement.mts) from where the location
// model had it at its last fix, which is the course forecasting chained it along (forecast.mts), so it's at each stop
// when its forecast says. Every leg, stop, and wait is the course's. A new fix or course moves where the model has
// the bus, and the drawn bus follows it (smoothed): slowing, never stopping while the model drives and never backing
// up, where it had got ahead, and hurrying, never faster than a bus, where it had fallen behind. On Oct 15's fixes
// that leaves it standing while the model moves 0 s an hour against 481 s for waiting on the model, and closing at
// 12 m/s over the model's speed at most against 62. The smoothing is the drawing's alone: what's learned of how the
// buses run comes from the fixes, never from where one was drawn

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import { routeLabel, type Feed } from "../../transit/feed.mts"
import { along, pointAt } from "../../geo/lines.mts"
import type { Coordinates } from "../../geo/projection.mts"
import type { RouteLine } from "../../transit/shapes.mts"
import type { Drawn } from "../state/following.mts"

const MAX_EXTRAPOLATION = 45 // s of driving guessed past a fix
const FRAME_MS = 50          // ~20 fps is plenty for buses
/** s the drawn bus takes to close most of its gap to the model, m/s over the model's speed it may hurry by at most, and m off the model past which it jumps there */
export const SMOOTHING = 4
export const CATCH_UP = 12
export const MAX_LAG = 300
/** s between frames past which the page was hidden, so the bus jumps to where the model has it rather than driving the gap */
const PAUSE = 5

/**
 * Where a bus is drawn a frame on: from `drawn` meters along its line toward the model's `modeled` meters, which
 * moves at `speed` m/s, over `dt` seconds. Never backwards, never slower than half the model's speed while ahead
 * of it, never more than CATCH_UP faster than the model while behind, and closing the gap over about SMOOTHING
 * seconds, or over a frame longer than that, so a long frame never overshoots. At the model's point it moves with
 * the model
 */
export const smoothed = (drawn: number, modeled: number, speed: number, dt: number) => {
  const v = Math.min(speed + CATCH_UP, Math.max(drawn > modeled ? speed / 2 : 0, speed + (modeled - drawn) / Math.max(SMOOTHING, dt)))
  return drawn + Math.max(0, v) * dt
}

/** How sure we are that a bus is where it's drawn, from how many seconds ago it reported */
export const confidence = (age: number) =>
  Math.min(1, Math.max(0.3, 1 - (age - 5) / 100))

type Fix = {
  /** The bus as last reported, where on its route that is, and its course from there, if it's on its route */
  bus: Drawn,
  /** Epoch milliseconds the GPS fix was taken, by our clock */
  at: number
}

/** Where a bus was last drawn: meters along its line, laps and all, as of epoch milliseconds */
type Smoothed = { line: RouteLine, distance: number, at: number }

/**
 * Meters along its line that a fix's bus has likely got to by now. The course is timed from the fix, by our clock,
 * and guessed at most MAX_EXTRAPOLATION past it
 */
const modeledDistance = ({ bus: { location, course }, at }: Fix, now: number) =>
  !course
    ? location!.distance
    : course.from + course.course.distanceAt(location!.at + Math.min(MAX_EXTRAPOLATION, Math.max(0, now - at) / 1000))

/**
 * Where a bus is drawn now, following the model from where it was last drawn: along its line toward where the model
 * has it, or there outright when it's first drawn, on another line, hidden a while, or further off than MAX_LAG,
 * as a new course can put it. Off its route there's no telling where it's headed, so it stays where it reported
 */
const drawn = (fix: Fix, was: Smoothed | undefined, now: number) => {
  const { vehicle, location } = fix.bus
  if (!location)
    return { point: [vehicle.lon, vehicle.lat] as Coordinates, bearing: vehicle.heading ?? 0, smoothed: undefined }

  const modeled = modeledDistance(fix, now)
  const dt = was ? (now - was.at) / 1000 : Infinity
  // The short way around a loop, in the model's own laps
  const gap = was?.line === location.line ? along(location.line, was.distance - modeled) : Infinity
  const distance =
    dt > PAUSE || Math.abs(gap) > MAX_LAG ? modeled :
    dt <= 0                              ? modeled + gap :
                                           smoothed(modeled + gap, modeled, (modeled - modeledDistance(fix, was!.at)) / dt, dt)
  return { ...pointAt(location.line, distance), smoothed: { line: location.line, distance, at: now } }
}

/** @returns where a bus is drawn right now, for things that follow it */
export const animateBuses = (
  map: MapLibre,
  feed: Reactive<Feed>,
  /** The buses as drawn, each with its course */
  buses: Reactive<ReadonlyMap<string, Drawn>>,
  /** Buses to draw larger with the rest faded, or a route whose buses stay bright with the rest faded */
  focus: Reactive<{ vehicles?: ReadonlySet<string>, route?: string }>
) => {
  let fixes = new Map<string, Fix>()
  const smoothing = new Map<string, Smoothed>()
  const positions = new Map<string, Coordinates>()

  watch(() => {
    // The wall clock, as the monotonic one stops while a phone sleeps, which would leave old fixes looking fresh
    const now = Date.now()
    const next = new Map<string, Fix>()
    for (const [id, bus] of buses.value) {
      const previous = fixes.get(id)
      const isSameFix = previous?.bus.vehicle === bus.vehicle
      next.set(id, isSameFix && previous.bus.course === bus.course ? previous : { bus, at: isSameFix ? previous.at : now - bus.vehicle.secsSinceReport * 1000 })
    }
    fixes = next
  })

  let lastFrame = 0
  const render = (frame: number) => {
    requestAnimationFrame(render)
    if (frame - lastFrame < FRAME_MS)
      return
    lastFrame = frame
    const now = Date.now()

    const { vehicles: focused, route: focusedRoute } = focus.peek()
    positions.clear()
    const features = [...fixes.values()].flatMap((fix): GeoJSON.Feature[] => {
      const { vehicle } = fix.bus
      const route = feed.peek().routesById.get(vehicle.route!.id)
      // Gone from a newer timetable
      if (!route)
        return []
      const { point, bearing, smoothed } = drawn(fix, smoothing.get(vehicle.id), now)
      if (smoothed)
        smoothing.set(vehicle.id, smoothed)
      else
        smoothing.delete(vehicle.id)
      const isFocused =
        focused      ? focused.has(vehicle.id) :
        focusedRoute ? focusedRoute === route.id :
                       undefined
      const sureness = confidence((now - fix.at) / 1000)
      positions.set(vehicle.id, point)
      return [{
        type: "Feature",
        properties: {
          id:      vehicle.id,
          route:   route.id,
          label:   routeLabel(route),
          text:    route.text,
          bearing,
          scale:   focused && isFocused ? 1.3 : 1,
          // Faded behind the focused ones, but never so far as to disappear
          opacity: isFocused === false ? Math.max(0.2, sureness * 0.4) : sureness
        },
        geometry: { type: "Point", coordinates: point }
      }]
    })
    for (const id of smoothing.keys())
      if (!fixes.has(id))
        smoothing.delete(id)
    map.getSource<GeoJSONSource>("vehicles")?.setData({ type: "FeatureCollection", features })
  }
  requestAnimationFrame(render)

  return (id: string) => positions.get(id)
}
