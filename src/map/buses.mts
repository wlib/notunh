// Buses drawn where we expect them to be now: driven along their route from the last GPS fix at the pace the model
// and buses lately have kept between stops and at them, waiting where their trip waits for its timetable, eased
// into each new fix without backing up, and faded the longer it's been since one

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import { routeLabel, tripBase, type Feed } from "./feed.mts"
import type { Vehicle } from "./umo.mts"
import { pointAt, routeLines, snapToLines, type Coordinates } from "./geometry.mts"
import { MIN_MOVING_KPH, createPace, expectedDistance, learnedPrior, observe, type Pace, type Trace } from "./pace.mts"
import { heldPositions, type Model } from "./model.mts"

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
  /** Where on its route the fix is and what it's been doing there, if it's on its route */
  trace?: Trace,
  /** Waiting out a layover before its next trip, so going nowhere */
  isLayover: boolean,
  /** Meters along the line that the bus was drawn ahead (+) or behind (-) of this fix's model when it arrived */
  lag: number,
  /** How far the drawn bus was from this fix's model off the line, eased away */
  correction: Coordinates,
  correctedAt: number
}

/** Meters along its line that a fix's bus has likely driven to by now */
const modeledDistance = (pace: Pace, { trace, at, isLayover }: Fix, now: number) =>
  isLayover
    ? trace!.track.distance
    : expectedDistance(pace, trace!, Math.min(MAX_EXTRAPOLATION, Math.max(0, now - at) / 1000))

const drawn = (pace: Pace, fix: Fix, now: number) => {
  const remaining = Math.max(0, 1 - (now - fix.correctedAt) / BLEND_MS)
  const ease = ({ point, bearing }: { point: Coordinates, bearing: number }) => ({
    point: [point[0] + fix.correction[0] * remaining, point[1] + fix.correction[1] * remaining] as Coordinates,
    bearing
  })

  // Off its route there's no telling where it's headed, so it stays where it reported
  if (!fix.trace)
    return { ...ease({ point: [fix.vehicle.lon, fix.vehicle.lat], bearing: fix.vehicle.heading }), distance: 0 }

  const modeled = modeledDistance(pace, fix, now)
  // A bus drawn ahead of its fix waits there until the model catches up, rather than reversing,
  // and one drawn behind hurries forward along the street
  const distance =
    fix.lag > 0
      ? Math.max(modeled, modeledDistance(pace, fix, fix.correctedAt) + fix.lag)
      : modeled + fix.lag * remaining
  return { ...ease(pointAt(fix.trace.track.line, distance)), distance }
}

/** @returns where a bus is drawn right now, for things that follow it */
export const animateBuses = (
  map: MapLibre,
  feed: Feed,
  model: Model,
  vehicles: Reactive<Vehicle[]>,
  /** Ids of buses on a layover */
  layovers: Reactive<ReadonlySet<string>>,
  /** Buses to draw larger, with the rest faded, or routes whose buses are the ones to show */
  focus: Reactive<{ vehicles?: ReadonlySet<string>, route?: string }>
) => {
  const linesByRoute = routeLines(feed)
  const trips = new Map(feed.trips.map(trip => [trip.id, trip]))
  /** What every bus has shown of how long stretches and stops take, shared by all of them */
  const pace = createPace(learnedPrior(model))

  /**
   * When a bus's trip is scheduled to leave the stops it waits at when early, between its first and last, which on a
   * loop are the same stop, where waiting is a layover
   */
  const holdsOf = (vehicle: Vehicle) => {
    const trip = vehicle.tripTag ? trips.get(vehicle.tripTag) : undefined
    const base = trip && tripBase(feed, trip, vehicle.gpsTime / 1000)
    if (!trip || base === undefined)
      return
    const held = heldPositions(model, feed, trip)
    return new Map(trip.stops.flatMap((stop, position) =>
      position > 0 && position < trip.stops.length - 1 && held[position] ? [[feed.stops[stop].id, base + trip.times[position]] as const] : []
    ))
  }

  let fixes = new Map<string, Fix>()
  const positions = new Map<string, Coordinates>()

  watch(() => {
    // The wall clock, as the monotonic one stops while a phone sleeps, which would leave old fixes looking fresh
    const now = Date.now()
    const next = new Map<string, Fix>()
    for (const vehicle of vehicles.value) {
      if (!vehicle.route || !feed.routesById.has(vehicle.route.id))
        continue

      const previous = fixes.get(vehicle.id)
      // Umo sometimes sends an older fix after a newer one, though a bus put on another route is news either way
      if (previous && vehicle.gpsTime <= previous.vehicle.gpsTime && previous.vehicle.route?.id === vehicle.route.id) {
        next.set(vehicle.id, previous)
        continue
      }

      // Speed is too rough to drive by, but tells a moving bus from a stopped one, whose heading means nothing
      const isMoving = vehicle.kph >= MIN_MOVING_KPH
      const track = snapToLines(linesByRoute.get(vehicle.route.id)!, vehicle, isMoving ? vehicle.heading : undefined, previous?.trace?.track)
      const fix: Fix = {
        vehicle,
        at: now - vehicle.secsSinceReport * 1000,
        trace: track && { ...observe(pace, previous?.trace, track, vehicle.gpsTime / 1000, !isMoving), holds: holdsOf(vehicle) },
        isLayover: layovers.peek().has(vehicle.id),
        lag: 0,
        correction: [0, 0],
        correctedAt: now
      }
      if (previous) {
        const was = drawn(pace, previous, now)
        if (fix.trace && previous.trace?.track.line === fix.trace.track.line) {
          // Along the street, the short way around a loop
          const { length, isLoop } = fix.trace.track.line
          const lag = was.distance - modeledDistance(pace, fix, now)
          const shortest = isLoop ? ((lag + length / 2) % length + length) % length - length / 2 : lag
          fix.lag = Math.abs(shortest) <= MAX_LAG ? shortest : 0
        }
        else {
          const is = drawn(pace, fix, now).point
          fix.correction = [was.point[0] - is[0], was.point[1] - is[1]]
        }
      }
      next.set(vehicle.id, fix)
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
    const features = [...fixes.values()].map((fix): GeoJSON.Feature => {
      const { point, bearing } = drawn(pace, fix, now)
      const route = feed.routesById.get(fix.vehicle.route!.id)!
      const isFocused =
        focused      ? focused.has(fix.vehicle.id) :
        focusedRoute ? focusedRoute === route.id :
                       undefined
      const sureness = confidence((now - fix.at) / 1000)
      positions.set(fix.vehicle.id, point)
      return {
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
      }
    })
    map.getSource<GeoJSONSource>("vehicles")?.setData({ type: "FeatureCollection", features })
  }
  requestAnimationFrame(render)

  return (id: string) => positions.get(id)
}
