// Buses drawn where we expect them to be now: along their course from where the location model has them as of their
// last fix (movement.mts), its legs at the pace the model expects and this bus has kept, slower pulling out and in
// as buses are, and waiting at stops as long as they do, or as their trip does for its timetable, eased into each
// new fix without backing up, and faded the longer it's been since one. The easing is the drawing's alone: what's
// learned of how the buses run comes from the fixes, never from where one was drawn

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import { routeLabel, type Feed } from "../../transit/feed.mts"
import type { Vehicle } from "../../transit/observations/umo.mts"
import { pointAt } from "../../geo/lines.mts"
import type { Coordinates } from "../../geo/projection.mts"
import type { Followed } from "../state/following.mts"

const MAX_EXTRAPOLATION = 45 // s of driving guessed past a fix
const BLEND_MS = 1500        // to ease from where a bus was drawn to where a new fix puts it
const MAX_LAG = 300         // m off a new fix along the line, past which the bus jumps there rather than easing
const FRAME_MS = 50          // ~20 fps is plenty for buses

/** How sure we are that a bus is where it's drawn, from how many seconds ago it reported */
export const confidence = (age: number) =>
  Math.min(1, Math.max(0.3, 1 - (age - 5) / 100))

type Fix = {
  vehicle: Vehicle,
  /** Epoch milliseconds the GPS fix was taken, by our clock */
  at: number,
  /** Where on its route the fix is, and its course from there, if it's on its route */
  followed: Followed,
  /** Waiting out a layover before its next trip, so going nowhere */
  isLayover: boolean,
  /** Meters along the line that the bus was drawn ahead (+) or behind (-) of this fix's model when it arrived */
  lag: number,
  /** How far the drawn bus was from this fix's model off the line, eased away */
  correction: Coordinates,
  correctedAt: number
}

/** Meters along its line that a fix's bus has likely got to by now, by our clock, which its course is timed from its fix by */
const modeledDistance = ({ followed: { location, course }, isLayover, at }: Fix, now: number) =>
  isLayover || !course
    ? location!.distance
    : course.from + course.course.distanceAt(location!.at + Math.min(MAX_EXTRAPOLATION, Math.max(0, now - at) / 1000))

const drawn = (fix: Fix, now: number) => {
  const remaining = Math.max(0, 1 - (now - fix.correctedAt) / BLEND_MS)
  const ease = ({ point, bearing }: { point: Coordinates, bearing: number }) => ({
    point: [point[0] + fix.correction[0] * remaining, point[1] + fix.correction[1] * remaining] as Coordinates,
    bearing
  })

  // Off its route there's no telling where it's headed, so it stays where it reported
  const { location } = fix.followed
  if (!location)
    return { ...ease({ point: [fix.vehicle.lon, fix.vehicle.lat], bearing: fix.vehicle.heading ?? 0 }), distance: 0 }

  const modeled = modeledDistance(fix, now)
  // A bus drawn ahead of its fix waits there until the model catches up, rather than reversing,
  // and one drawn behind hurries forward along the street
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
  /** The buses as followed, each with its course */
  followed: Reactive<ReadonlyMap<string, Followed>>,
  /** Ids of buses on a layover */
  layovers: Reactive<ReadonlySet<string>>,
  /** Buses to draw larger, with the rest faded, or routes whose buses are the ones to show */
  focus: Reactive<{ vehicles?: ReadonlySet<string>, route?: string }>
) => {
  let fixes = new Map<string, Fix>()
  const positions = new Map<string, Coordinates>()

  watch(() => {
    // The wall clock, as the monotonic one stops while a phone sleeps, which would leave old fixes looking fresh
    const now = Date.now()
    const next = new Map<string, Fix>()
    for (const [id, bus] of followed.value) {
      const { vehicle } = bus
      const previous = fixes.get(id)
      if (previous?.vehicle === vehicle) {
        next.set(id, previous)
        continue
      }
      const fix: Fix = {
        vehicle,
        at: now - vehicle.secsSinceReport * 1000,
        followed: bus,
        isLayover: layovers.peek().has(id),
        lag: 0,
        correction: [0, 0],
        correctedAt: now
      }
      if (previous) {
        const was = drawn(previous, now)
        const { location } = bus
        if (location && previous.followed.location?.line === location.line) {
          // Along the street, the short way around a loop
          const { length, isLoop } = location.line
          const lag = was.distance - modeledDistance(fix, now)
          const shortest = isLoop ? ((lag + length / 2) % length + length) % length - length / 2 : lag
          fix.lag = Math.abs(shortest) <= MAX_LAG ? shortest : 0
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
      const route = feed.peek().routesById.get(fix.vehicle.route!.id)
      // Gone from a newer timetable
      if (!route)
        return []
      const { point, bearing } = drawn(fix, now)
      const isFocused =
        focused      ? focused.has(fix.vehicle.id) :
        focusedRoute ? focusedRoute === route.id :
                       undefined
      const sureness = confidence((now - fix.at) / 1000)
      positions.set(fix.vehicle.id, point)
      return [{
        type: "Feature",
        properties: {
          id:      fix.vehicle.id,
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
