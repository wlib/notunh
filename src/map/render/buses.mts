// Buses drawn where we expect them to be now. Each moves along its course (movement.mts) from where the location
// model had it at its last fix, which is the course forecasting chained it along (forecast.mts), so it's at each stop
// when its forecast says. Every leg, stop, and wait is the course's. Each new fix or course is eased into without
// backing up, and a bus fades the longer it's been since a fix. The easing is the drawing's alone: what's learned of
// how the buses run comes from the fixes, never from where one was drawn

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import { routeLabel, type Feed } from "../../transit/feed.mts"
import { along, pointAt } from "../../geo/lines.mts"
import type { Coordinates } from "../../geo/projection.mts"
import type { Drawn } from "../state/following.mts"

const MAX_EXTRAPOLATION = 45 // s of driving guessed past a fix
const BLEND_MS = 1500        // to ease from where a bus was drawn to where a new fix puts it
const MAX_LAG = 300         // m off a new fix along the line, past which the bus jumps there rather than easing
const FRAME_MS = 50          // ~20 fps is plenty for buses

/** How sure we are that a bus is where it's drawn, from how many seconds ago it reported */
export const confidence = (age: number) =>
  Math.min(1, Math.max(0.3, 1 - (age - 5) / 100))

type Fix = {
  /** The bus as last reported, where on its route that is, and its course from there, if it's on its route */
  bus: Drawn,
  /** Epoch milliseconds the GPS fix was taken, by our clock */
  at: number,
  /** Meters along the line that the bus was drawn ahead (+) or behind (-) of this course when it came */
  lag: number,
  /** How far the drawn bus was from this fix's model off the line, eased away */
  correction: Coordinates,
  correctedAt: number
}

/**
 * Meters along its line that a fix's bus has likely got to by now. The course is timed from the fix, by our clock,
 * and guessed at most MAX_EXTRAPOLATION past it
 */
const modeledDistance = ({ bus: { location, course }, at }: Fix, now: number) =>
  !course
    ? location!.distance
    : course.from + course.course.distanceAt(location!.at + Math.min(MAX_EXTRAPOLATION, Math.max(0, now - at) / 1000))

const drawn = (fix: Fix, now: number) => {
  const remaining = Math.max(0, 1 - (now - fix.correctedAt) / BLEND_MS)
  const ease = ({ point, bearing }: { point: Coordinates, bearing: number }) => ({
    point: [point[0] + fix.correction[0] * remaining, point[1] + fix.correction[1] * remaining] as Coordinates,
    bearing
  })

  // Off its route there's no telling where it's headed, so it stays where it reported
  const { vehicle, location } = fix.bus
  if (!location)
    return { ...ease({ point: [vehicle.lon, vehicle.lat], bearing: vehicle.heading ?? 0 }), distance: 0 }

  const modeled = modeledDistance(fix, now)
  // A bus drawn ahead of its fix waits there until the model catches up, rather than reversing. One drawn behind
  // hurries forward along the street
  const distance =
    fix.lag > 0
      ? Math.max(modeled, modeledDistance(fix, fix.correctedAt) + fix.lag)
      : modeled + fix.lag * remaining
  return { ...ease(pointAt(location.line, distance)), distance }
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
  const positions = new Map<string, Coordinates>()

  watch(() => {
    // The wall clock, as the monotonic one stops while a phone sleeps, which would leave old fixes looking fresh
    const now = Date.now()
    const next = new Map<string, Fix>()
    for (const [id, bus] of buses.value) {
      const { vehicle, location, course } = bus
      const previous = fixes.get(id)
      const isSameFix = previous?.bus.vehicle === vehicle
      if (isSameFix && previous.bus.course === course) {
        next.set(id, previous)
        continue
      }
      const fix: Fix = {
        bus,
        at: isSameFix ? previous.at : now - vehicle.secsSinceReport * 1000,
        lag: 0,
        correction: [0, 0],
        correctedAt: now
      }
      if (previous) {
        const was = drawn(previous, now)
        if (location && previous.bus.location?.line === location.line) {
          // Along the street, the short way around a loop
          const lag = along(location.line, was.distance - modeledDistance(fix, now))
          fix.lag = Math.abs(lag) <= MAX_LAG ? lag : 0
        }
        else {
          const is = drawn(fix, now).point
          fix.correction = [was.point[0] - is[0], was.point[1] - is[1]]
        }
      }
      next.set(id, fix)
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
      const { point, bearing } = drawn(fix, now)
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
    map.getSource<GeoJSONSource>("vehicles")?.setData({ type: "FeatureCollection", features })
  }
  requestAnimationFrame(render)

  return (id: string) => positions.get(id)
}
