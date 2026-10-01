// Buses drawn where we expect them to be now: driven along their route from the last GPS fix at the pace
// buses have lately kept between stops and at them, eased into each new fix without backing up,
// and faded the longer it's been since one

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import { routeLabel, type Feed } from "./feed.mts"
import { STALE_VEHICLE_SECONDS, type Vehicle } from "./umo.mts"
import { pointAt, snapToLines, toLine, type Coordinates, type Line } from "./geometry.mts"
import { createPace, expectedDistance, observe, type Trace } from "./pace.mts"

const MAX_EXTRAPOLATION = 45 // s of driving guessed past a fix
const BLEND_MS = 1500        // to ease from where a bus was drawn to where a new fix puts it
const MAX_LAG = 300         // m off a new fix along the line, past which the bus jumps there rather than easing
const MIN_MOVING_KPH = 3     // slower is idling at a stop, with a meaningless heading
const FRAME_MS = 50          // ~20 fps is plenty for buses

/** How sure we are that a bus is where it's drawn, from how many seconds ago it reported */
export const confidence = (age: number) =>
  Math.min(1, Math.max(0.3, 1 - (age - 5) / 100))

type Fix = {
  vehicle: Vehicle,
  /** performance.now() when the GPS fix was taken */
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

/** What every bus has shown of how long stretches and stops take, shared by all of them */
const pace = createPace()

/** Meters along its line that a fix's bus has likely driven to by now */
const modeledDistance = ({ trace, at, isLayover }: Fix, now: number) =>
  isLayover
    ? trace!.track.distance
    : expectedDistance(pace, trace!, Math.min(MAX_EXTRAPOLATION, (now - at) / 1000))

const drawn = (fix: Fix, now: number) => {
  const remaining = Math.max(0, 1 - (now - fix.correctedAt) / BLEND_MS)
  const ease = ({ point, bearing }: { point: Coordinates, bearing: number }) => ({
    point: [point[0] + fix.correction[0] * remaining, point[1] + fix.correction[1] * remaining] as Coordinates,
    bearing
  })

  // Off its route there's no telling where it's headed, so it stays where it reported
  if (!fix.trace)
    return { ...ease({ point: [fix.vehicle.lon, fix.vehicle.lat], bearing: fix.vehicle.heading }), distance: 0 }

  const modeled = modeledDistance(fix, now)
  // A bus drawn ahead of its fix waits there until the model catches up, rather than reversing,
  // and one drawn behind hurries forward along the street
  const distance =
    fix.lag > 0
      ? Math.max(modeled, modeledDistance(fix, fix.correctedAt) + fix.lag)
      : modeled + fix.lag * remaining
  return { ...ease(pointAt(fix.trace.track.line, distance)), distance }
}

/** @returns where a bus is drawn right now, for things that follow it */
export const animateBuses = (
  map: MapLibre,
  feed: Feed,
  vehicles: Reactive<Vehicle[]>,
  /** Ids of buses on a layover */
  layovers: Reactive<ReadonlySet<string>>,
  /** Buses to draw larger, with the rest faded, or routes whose buses are the ones to show */
  focus: Reactive<{ vehicles?: ReadonlySet<string>, route?: string }>
) => {
  const linesByRoute = new Map(feed.routes.map(route => {
    const trips = feed.trips.filter(trip => trip.route === route.id)
    return [
      route.id,
      [...new Set(trips.map(trip => trip.shape))].map(shape =>
        toLine(
          feed.shapes[shape],
          trips
            .filter(trip => trip.shape === shape)
            .map(trip => trip.stops.map(stop => feed.stops[stop]))
        )
      )
    ] as [string, Line[]]
  }))

  let fixes = new Map<string, Fix>()
  const positions = new Map<string, Coordinates>()

  watch(() => {
    const now = performance.now()
    const next = new Map<string, Fix>()
    for (const vehicle of vehicles.value) {
      if (!vehicle.route || !feed.routesById.has(vehicle.route.id) || vehicle.secsSinceReport >= STALE_VEHICLE_SECONDS)
        continue

      const previous = fixes.get(vehicle.id)
      // Umo sometimes sends an older fix after a newer one
      if (previous && vehicle.gpsTime <= previous.vehicle.gpsTime) {
        next.set(vehicle.id, previous)
        continue
      }

      // Speed is too rough to drive by, but tells a moving bus from a stopped one, whose heading means nothing
      const isMoving = vehicle.kph >= MIN_MOVING_KPH
      const track = snapToLines(linesByRoute.get(vehicle.route.id)!, vehicle, isMoving ? vehicle.heading : undefined, previous?.trace?.track)
      const fix: Fix = {
        vehicle,
        at: now - vehicle.secsSinceReport * 1000,
        trace: track && observe(pace, previous?.trace, track, vehicle.gpsTime / 1000, !isMoving),
        isLayover: layovers.peek().has(vehicle.id),
        lag: 0,
        correction: [0, 0],
        correctedAt: now
      }
      if (previous) {
        const was = drawn(previous, now)
        if (fix.trace && previous.trace?.track.line === fix.trace.track.line) {
          // Along the street, the short way around a loop
          const { length, isLoop } = fix.trace.track.line
          const lag = was.distance - modeledDistance(fix, now)
          const shortest = isLoop ? ((lag + length / 2) % length + length) % length - length / 2 : lag
          fix.lag = Math.abs(shortest) <= MAX_LAG ? shortest : 0
        }
        else {
          const is = drawn(fix, now).point
          fix.correction = [was.point[0] - is[0], was.point[1] - is[1]]
        }
      }
      next.set(vehicle.id, fix)
    }
    fixes = next
  })

  let lastFrame = 0
  const render = (now: number) => {
    requestAnimationFrame(render)
    if (now - lastFrame < FRAME_MS)
      return
    lastFrame = now

    const { vehicles: focused, route: focusedRoute } = focus.peek()
    positions.clear()
    const features = [...fixes.values()].map((fix): GeoJSON.Feature => {
      const { point, bearing } = drawn(fix, now)
      const route = feed.routesById.get(fix.vehicle.route!.id)!
      const isFocused =
        focused      ? focused.has(fix.vehicle.id) :
        focusedRoute ? focusedRoute === route.id :
                       undefined
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
          opacity: confidence((now - fix.at) / 1000) * (isFocused === false ? 0.25 : 1)
        },
        geometry: { type: "Point", coordinates: point }
      }
    })
    map.getSource<GeoJSONSource>("vehicles")?.setData({ type: "FeatureCollection", features })
  }
  requestAnimationFrame(render)

  return (id: string) => positions.get(id)
}
