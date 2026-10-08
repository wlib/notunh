import { test, expect } from "vitest"
import fc from "fast-check"
import { serviceDayStart, withIndexes, type Feed } from "../../src/map/feed.mts"
import { pointAt, routeLines, type Coordinates } from "../../src/map/geometry.mts"
import { ZONE } from "../../src/map/pace.mts"
import { extract } from "../../src/map/events.mts"
import type { BusFix } from "../../src/map/raw.mts"

const DAY = "2026-10-05"
const BASE = serviceDayStart(DAY) / 1000
const CENTER = { lat: 43.135, lon: -70.93 }

// A closed loop like the campus connectors, about 6 km around with a vertex every 30 m or so
const loop: Coordinates[] = Array.from({ length: 201 }, (_, i) => {
  const angle = 2 * Math.PI * i / 200
  return [CENTER.lon + 0.0123 * Math.cos(angle), CENTER.lat + 0.009 * Math.sin(angle)]
})

// Stops on a few of its vertices, at least a few hundred meters apart, the first one also where each loop ends
const stopVertices = fc
  .uniqueArray(fc.integer({ min: 1, max: 19 }), { minLength: 2, maxLength: 8 })
  .map(slots => [0, ...slots.sort((a, b) => a - b).map(slot => slot * 10)])

/** Two loops of the same stops, back to back, as the timetable has them */
const feedOf = (vertices: number[]): Feed => {
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

/**
 * A bus driving loops at a steady speed, stopping at each stop for its wait, laying over between loops, reporting
 * at uneven intervals with some reports repeated, tagged with each loop's trip
 * @returns its fixes, shuffled a little as they'd arrive, and when it got to and left each stop
 */
const drive = (feed: Feed, speed: number, waits: number[], layover: number, every: number[]) => {
  const line = routeLines(feed).get("R")![0]
  const positions = line.stops.map(stop => stop.distance)
  const legs: { start: number, end: number, from: number, to: number, trip: string }[] = []
  const stays: { stop: number, lap: number, arrive: number, depart: number }[] = []
  let [time, at] = [BASE + 9 * 3600, 0]
  for (const [lap, trip] of ["T0", "T1"].entries()) {
    positions.forEach((stop, i) => {
      const target = lap * line.length + stop
      if (target > at) {
        // Coming back around to the first stop finishes the loop before
        legs.push({ start: time, end: time + (target - at) / speed, from: at, to: target, trip: i === 0 ? "T0" : trip })
        time += (target - at) / speed
        at = target
      }
      const wait = i === 0 && lap === 1 ? layover : waits[i % waits.length]
      stays.push({ stop: i, lap, arrive: time - ZONE / speed, depart: time + wait + ZONE / speed })
      legs.push({ start: time, end: time + wait, from: at, to: at, trip: i === 0 && lap === 1 ? "T1" : trip })
      time += wait
    })
  }
  // And back to the start
  legs.push({ start: time, end: time + (2 * line.length - at) / speed, from: at, to: 2 * line.length, trip: "T1" })
  time += (2 * line.length - at) / speed

  // Reporting on for a minute after, sitting at the end
  const fixes: BusFix[] = []
  for (let t = BASE + 9 * 3600, i = 0; t <= time + 60; t += every[i++ % every.length]) {
    const leg = legs.find(leg => t <= leg.end) ?? legs.at(-1)!
    const distance = leg.end === leg.start ? leg.to : leg.from + (leg.to - leg.from) * Math.min(1, (t - leg.start) / (leg.end - leg.start))
    const { point: [lon, lat], bearing } = pointAt(line, distance)
    const isMoving = leg.to !== leg.from && t < leg.end
    fixes.push({ vehicle: "V", at: t * 1000, lat, lon, heading: bearing, kph: isMoving ? speed * 3.6 : 0, trip: leg.trip, route: "R", stop: null })
  }
  // Polled twice across a minute boundary, and one arriving out of order
  return { fixes: [...fixes, ...fixes.filter((_, i) => i % 7 === 0)].reverse(), stays, every }
}

const scenario = fc.record({
  vertices: stopVertices,
  speed:    fc.integer({ min: 4, max: 12 }),
  waits:    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 4 }),
  layover:  fc.integer({ min: 60, max: 600 }),
  every:    fc.array(fc.integer({ min: 4, max: 30 }), { minLength: 1, maxLength: 5 })
})

test("a bus's fixes show each stop it went through, in order, timed to within its reports", () =>
  fc.assert(fc.property(scenario, ({ vertices, speed, waits, layover, every }) => {
    const feed = feedOf(vertices)
    const { fixes, stays } = drive(feed, speed, waits, layover, every)
    const visits = extract(feed, fixes)
    const bound = Math.max(...every)

    visits.slice(1).forEach((visit, i) => expect(visit.arrive).toBeGreaterThanOrEqual(visits[i].depart))
    for (const visit of visits) {
      expect(visit.depart).toBeGreaterThanOrEqual(visit.arrive)
      // Each one is a stop the bus really went through, then
      const stay = stays.find(stay => `s${stay.stop}` === visit.stop && Math.abs(stay.arrive - visit.arrive) <= bound)
      expect(stay).toBeDefined()
      expect(Math.abs(stay!.depart - visit.depart)).toBeLessThanOrEqual(bound)
    }
    // Every stop but the very first is seen, as the bus is only tracked from the first report
    expect(visits.length).toBeGreaterThanOrEqual(stays.length - 1)
  }))
)

test("visits follow their trip's stops in order, with the drive from the stop before", () =>
  fc.assert(fc.property(scenario, ({ vertices, speed, waits, layover, every }) => {
    const feed = feedOf(vertices)
    const visits = extract(feed, drive(feed, speed, waits, layover, every).fixes)
    for (const trip of ["T0", "T1"]) {
      const on = visits.filter(visit => visit.trip === trip)
      expect(on.length).toBeGreaterThan(0)
      on.slice(1).forEach((visit, i) => {
        expect(visit.position).toBeGreaterThan(on[i].position!)
        if (visit.position === on[i].position! + 1) {
          expect(visit.from).toBe(on[i].stop)
          expect(visit.left).toBeCloseTo(on[i].depart, 6)
        }
      })
      for (const visit of on)
        expect(visit.scheduled).toBe(BASE + feed.trips.find(({ id }) => id === trip)!.times[visit.position!])
    }
  }))
)

test("the layover between two trips of one bus is from getting in at the end of one to leaving on the next", () =>
  fc.assert(fc.property(scenario, ({ vertices, speed, waits, layover, every }) => {
    const feed = feedOf(vertices)
    const { fixes, stays } = drive(feed, speed, waits, layover, every)
    const layovers = extract(feed, fixes).filter(visit => visit.gotIn !== undefined)
    const stay = stays.find(stay => stay.stop === 0 && stay.lap === 1)!
    expect(layovers).toHaveLength(1)
    expect(layovers[0]).toMatchObject({ trip: "T1", position: 0, stop: "s0" })
    expect(Math.abs(layovers[0].gotIn! - stay.arrive)).toBeLessThanOrEqual(Math.max(...every))
    expect(Math.abs(layovers[0].depart - stay.depart)).toBeLessThanOrEqual(Math.max(...every))
  }))
)

test("nothing is made up across a gap in a bus's reports", () =>
  fc.assert(fc.property(scenario, fc.integer({ min: 0, max: 1000 }), ({ vertices, speed, waits, layover, every }, skip) => {
    const feed = feedOf(vertices)
    const { fixes } = drive(feed, speed, waits, layover, every)
    const sorted = [...new Map(fixes.map(fix => [fix.at, fix])).values()].sort((a, b) => a.at - b.at)
    // Forty minutes without a report, from somewhere along the way
    const from = sorted[skip % sorted.length].at
    const gapped = sorted.filter(fix => fix.at < from || fix.at >= from + 2_400_000)
    for (const visit of extract(feed, gapped)) {
      expect(visit.arrive * 1000 < from || visit.arrive * 1000 >= from + 2_400_000).toBe(true)
      if (visit.gotIn !== undefined)
        expect(visit.gotIn * 1000 < from || visit.gotIn * 1000 >= from + 2_400_000).toBe(true)
    }
  }))
)
