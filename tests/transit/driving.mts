// A bus driving a loop as buses do, for tests. It speeds up from each stop it waits at, cruises, brakes into the next,
// and goes straight through those it doesn't wait at. It reports fixes at uneven intervals, and keeps when it really
// got to and left each stop, to check what's read of its fixes against

import fc from "fast-check"
import { serviceDayStart, withIndexes, type Feed } from "../../src/transit/feed.mts"
import { pointAt } from "../../src/geo/lines.mts"
import type { Coordinates } from "../../src/geo/projection.mts"
import { routeLines } from "../../src/transit/shapes.mts"
import type { BusFix } from "../../src/transit/observations/raw.mts"

export const DAY = "2026-10-05"
export const BASE = serviceDayStart(DAY) / 1000
const CENTER = { lat: 43.135, lon: -70.93 }

// A closed loop like the campus connectors, about 6 km around with a vertex every 30 m or so
const loop: Coordinates[] = Array.from({ length: 201 }, (_, i) => {
  const angle = 2 * Math.PI * i / 200
  return [CENTER.lon + 0.0123 * Math.cos(angle), CENTER.lat + 0.009 * Math.sin(angle)]
})

/** Stops on a few of its vertices, at least a few hundred meters apart, the first one also where each loop ends */
export const stopVertices = fc
  .uniqueArray(fc.integer({ min: 1, max: 19 }), { minLength: 2, maxLength: 8 })
  .map(slots => [0, ...slots.sort((a, b) => a - b).map(slot => slot * 10)])

/** Two loops of the same stops, back to back, as the timetable has them */
export const feedOf = (vertices: number[]): Feed => {
  const stops = vertices.map((vertex, i) => ({ id: `s${i}`, name: "", lon: loop[vertex][0], lat: loop[vertex][1] }))
  const trip = (id: string, start: number) => ({
    id, route: "R", service: "daily", headsign: "", shape: "L",
    stops: [...stops.keys(), 0],
    times: [...stops.keys(), stops.length].map(i => start + i * 120),
    timepoints: []
  })
  return withIndexes({
    version: "test", start: "2000-01-01", end: "2099-12-31",
    routes: [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
    stops,
    services: { daily: { days: 127, start: "2000-01-01", end: "2099-12-31", added: [], removed: [] } },
    trips: [trip("T0", 9 * 3600), trip("T1", 9 * 3600 + 3600)],
    shapes: { L: loop }
  })
}

/** How a bus drives a scenario: cruising speed, how long it waits at each stop (none: straight through), and its layover */
export const scenario = fc.record({
  vertices: stopVertices,
  cruise:   fc.integer({ min: 5, max: 14 }),
  waits:    fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 5, max: 90 })), { minLength: 1, maxLength: 4 }),
  layover:  fc.integer({ min: 60, max: 600 }),
  every:    fc.array(fc.integer({ min: 8, max: 30 }), { minLength: 1, maxLength: 5 })
})

// m/s² it speeds up and brakes by
const ACCELERATION = 1
const BRAKING = 1.2

/** When a bus got to a stop on a lap, and left it */
export type Stay = { stop: number, lap: number, arrive: number, depart: number }

/**
 * A bus driving two loops from the first stop, waiting at each stop as long as its waits say in turn, laying over
 * between loops, tagged with each loop's trip, reporting at the intervals of `every` in turn, on for a minute after
 * @returns its fixes, out of order as they may arrive, with some sent twice, and when it got to and left each stop
 */
export const drive = (feed: Feed, { cruise, waits, layover, every }: { cruise: number, waits: number[], layover: number, every: number[] }) => {
  const line = routeLines(feed).get("R")![0]
  const stops = line.stops.map(stop => stop.distance)
  // Every place it stops or goes through, laps and all, ending back at the first stop
  const visits = [0, 1].flatMap(lap => stops.map((distance, i) => ({
    stop: i, lap, distance: distance + lap * line.length,
    wait: i === 0 ? (lap ? layover : 0) : waits[(i - 1) % waits.length]
  })))
  visits.push({ stop: 0, lap: 2, distance: 2 * line.length, wait: 60 })

  // Each stretch from a standstill to the next, as speeding up, cruising, and braking: where it is and how fast
  type Stretch = { start: number, from: number, to: number, peak: number, up: number, down: number, time: number }
  const stretch = (start: number, from: number, to: number): Stretch => {
    const meters = to - from
    const peak = Math.min(cruise, Math.sqrt(2 * meters / (1 / ACCELERATION + 1 / BRAKING)))
    const [up, down] = [peak / ACCELERATION, peak / BRAKING]
    return { start, from, to, peak, up, down, time: up + down + (meters - peak * peak / (2 * ACCELERATION) - peak * peak / (2 * BRAKING)) / peak }
  }
  const along = ({ start, from, peak, up, down, time }: Stretch, t: number) => {
    const s = Math.max(0, Math.min(time, t - start))
    const cruising = time - up - down
    if (s <= up)
      return { distance: from + ACCELERATION * s * s / 2, speed: ACCELERATION * s }
    if (s <= up + cruising)
      return { distance: from + peak * up / 2 + peak * (s - up), speed: peak }
    const left = time - s
    return { distance: from + peak * up / 2 + peak * cruising + (peak * down / 2 - BRAKING * left * left / 2), speed: BRAKING * left }
  }

  const stays: Stay[] = []
  const stretches: Stretch[] = []
  let time = BASE + 9 * 3600
  let from = 0
  for (const visit of visits.slice(1)) {
    // Straight through where it doesn't wait, timed along the stretch to where it next does
    if (!visit.wait && visit.lap < 2)
      continue
    const piece = stretch(time, from, visit.distance)
    stretches.push(piece)
    for (const through of visits)
      if (!through.wait && through.distance > from && through.distance < visit.distance) {
        let [low, high] = [time, time + piece.time]
        for (let k = 0; k < 50; k++) {
          const middle = (low + high) / 2
          if (along(piece, middle).distance < through.distance)
            low = middle
          else
            high = middle
        }
        stays.push({ stop: through.stop, lap: through.lap, arrive: high, depart: high })
      }
    time += piece.time
    stays.push({ stop: visit.stop, lap: visit.lap, arrive: time, depart: time + visit.wait })
    time += visit.wait
    from = visit.distance
  }
  stays.sort((a, b) => a.arrive - b.arrive)

  const at = (t: number) => {
    const piece = stretches.find(piece => t < piece.start + piece.time)
    // Waiting at a stop, between stretches
    if (!piece || t < piece.start)
      return { distance: piece ? piece.from : stretches.at(-1)!.to, speed: 0 }
    return along(piece, t)
  }
  const fixes: BusFix[] = []
  for (let t = BASE + 9 * 3600, i = 0; t <= time; t += every[i++ % every.length]) {
    const { distance, speed } = at(t)
    const { point: [lon, lat], bearing } = pointAt(line, distance)
    const lap = Math.floor(distance / line.length)
    const trip = lap === 0 || (lap === 1 && distance - line.length < 1 && stays.find(stay => stay.stop === 0 && stay.lap === 1)!.depart > t) ? "T0" : "T1"
    fixes.push({ vehicle: "V", at: Math.round(t) * 1000, lat, lon, heading: Math.round(bearing), kph: Math.round(speed * 3.6), trip, route: "R", stop: null })
  }
  // Some polled twice, as across a minute boundary, and all arriving out of order
  return { fixes: [...fixes, ...fixes.filter((_, i) => i % 7 === 0)].reverse(), stays, line, every }
}
