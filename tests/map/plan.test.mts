import { test, expect } from "vitest"
import fc from "fast-check"
import { distance, serviceDayStart, withIndexes, type Feed, type FeedData } from "../../src/map/feed.mts"
import {
  ALTERNATIVES, HORIZON, MAX_ACCESS_WALK, MAX_TRANSFER_WALK, MIN_TIME_SAVED, TRANSFER_BUFFER,
  buildConnections, buildRuns, byArrival, cost, latestDeparture, plan, scan, timeAt, walkOnly, walkSeconds,
  type Itinerary, type Place, type Run
} from "../../src/map/plan.mts"

// The planner properties are cheap and the interesting cases are rare, so look harder
fc.configureGlobal({ numRuns: 1000 })
const TODAY = 20261001
const BASE = serviceDayStart(TODAY) / 1000
const CENTER = { lat: 43.135, lon: -70.93 }

// Integers, since fc.double favors edge cases like 0 that would pile every stop in one spot
const offset = (place: { lat: number, lon: number }, size: number) =>
  fc
    .tuple(fc.integer({ min: -size, max: size }), fc.integer({ min: -size, max: size }))
    .map(([lat, lon]): Place => ({ lat: place.lat + lat * 1e-5, lon: place.lon + lon * 1.4e-5, name: "" }))

// Spread over several km, so riding beats walking and transfers matter
const near = offset(CENTER, 8000)

// Small feeds: a few stops within a few km, a few trips that may revisit stops like loops do
const feed = fc
  .array(near, { minLength: 2, maxLength: 8 })
  .chain(stops =>
    fc.record({
      stops: fc.constant(stops),
      trips: fc.array(
        fc.record({
          stops: fc.array(fc.nat(stops.length - 1), { minLength: 2, maxLength: 6 }),
          first: fc.integer({ min: 7 * 3600, max: 11 * 3600 }),
          gaps:  fc.array(fc.nat({ max: 300 }), { minLength: 8, maxLength: 8 })
        }),
        { minLength: 1, maxLength: 8 }
      )
    })
  )
  .map(({ stops, trips }): Feed => {
    const data: FeedData = {
      version: "test",
      start: 20000101,
      end: 20991231,
      routes: [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
      stops: stops.map((stop, i) => ({ ...stop, id: `${i}`, name: `Stop ${i}` })),
      services: { daily: { days: 127, start: 20000101, end: 20991231, added: [], removed: [] } },
      trips: trips.map((trip, i) => {
        let time = trip.first
        return {
          id: `T${i}`,
          route: "R",
          service: "daily",
          headsign: "",
          shape: "",
          stops: trip.stops,
          times: trip.stops.map((_, j) => j === 0 ? time : time += trip.gaps[j - 1])
        }
      }),
      shapes: {}
    }
    return withIndexes(data)
  })

// Starting near where some trip is about to leave, and ending near a stop some trip reaches
const scenario = feed.chain(feed =>
  fc.record({
    feed: fc.constant(feed),
    trip: fc.constantFrom(...feed.trips),
    destination: fc.constantFrom(...feed.trips.flatMap(trip => trip.stops.slice(1))),
    early: fc.nat({ max: 1200 })
  })
  .chain(({ trip, destination, early }) =>
    fc.record({
      feed:  fc.constant(feed),
      from:  offset(feed.stops[trip.stops[0]], 400),
      to:    offset(feed.stops[destination], 400),
      start: fc.constant(BASE + trip.times[0] - early)
    })
  )
)

// The earliest arrival over every itinerary with at most two rides, by brute force
const bruteForce = (feed: Feed, runs: Run[], from: Place, to: Place, start: number) => {
  let best = Infinity
  const stops = feed.stops

  const finish = (stop: number, time: number) => {
    if (distance(stops[stop], to) <= MAX_ACCESS_WALK)
      best = Math.min(best, time + walkSeconds(distance(stops[stop], to)))
    stops.forEach((other, i) => {
      const meters = distance(stops[stop], other)
      if (i !== stop && meters <= MAX_TRANSFER_WALK && distance(other, to) <= MAX_ACCESS_WALK)
        best = Math.min(best, time + walkSeconds(meters) + walkSeconds(distance(other, to)))
    })
  }

  const rides = function * (ready: (stop: number) => number) {
    for (const run of runs)
      for (let i = 0; i < run.trip.stops.length; i++)
        for (let j = i + 1; j < run.trip.stops.length; j++)
          if (
            timeAt(run, i) >= ready(run.trip.stops[i]) &&
            timeAt(run, i) >= start &&
            timeAt(run, j - 1) <= start + HORIZON
          )
            yield { run, alight: run.trip.stops[j], arrival: timeAt(run, j) }
  }

  const access = (stop: number) =>
    distance(from, stops[stop]) <= MAX_ACCESS_WALK
      ? start + walkSeconds(distance(from, stops[stop]))
      : Infinity

  for (const first of rides(access)) {
    finish(first.alight, first.arrival)

    const transfer = (stop: number) => {
      const meters = distance(stops[first.alight], stops[stop])
      return (
        stop === first.alight              ? first.arrival + TRANSFER_BUFFER :
        meters <= MAX_TRANSFER_WALK        ? first.arrival + walkSeconds(meters) + TRANSFER_BUFFER :
                                             Infinity
      )
    }
    for (const second of rides(transfer))
      if (second.run !== first.run)
        finish(second.alight, second.arrival)
  }
  return best
}

const expectValid = (feed: Feed, itinerary: Itinerary, from: Place, to: Place, start: number) => {
  expect(itinerary.start).toBeGreaterThanOrEqual(start)
  expect(itinerary.end).toBe(itinerary.legs.at(-1)!.end)

  let at: Place = from
  let time = itinerary.start
  let hasRidden = false
  let previousRun: Run | undefined
  for (const leg of itinerary.legs) {
    expect(leg.start).toBeGreaterThanOrEqual(time)
    if (leg.kind === "walk") {
      expect(distance(at, leg.from)).toBe(0)
      expect(leg.meters).toBeCloseTo(distance(leg.from, leg.to), 3)
      expect(leg.end - leg.start).toBe(walkSeconds(leg.meters))
      at = leg.to
    }
    else {
      const { run, fromPosition, toPosition } = leg
      expect(fromPosition).toBeLessThan(toPosition)
      expect(distance(at, feed.stops[run.trip.stops[fromPosition]])).toBe(0)
      expect(leg.start).toBe(timeAt(run, fromPosition))
      expect(leg.end).toBe(timeAt(run, toPosition))
      if (hasRidden && run !== previousRun)
        expect(leg.start).toBeGreaterThanOrEqual(time + TRANSFER_BUFFER)
      hasRidden = true
      previousRun = run
      at = feed.stops[run.trip.stops[toPosition]]
    }
    time = leg.end
  }
  expect(distance(at, to)).toBe(0)
}

// Rounding walk times to the second can make a detour via a stop look a second or two quicker
const beatsWalking = (from: Place, to: Place, start: number, end: number) =>
  end < walkOnly(from, to, start).end - 2

// When riding only ties walking somewhere along the way, scan rightly prefers walking there,
// which is the walk-only option and not a bus itinerary, so these properties are about buses that help
test("scan finds valid itineraries at least as early as any with two rides", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const itinerary = scan(feed, runs, buildConnections(runs, start), from, to, start)
    const best = bruteForce(feed, runs, from, to, start)

    if (itinerary)
      expectValid(feed, itinerary, from, to, start)
    if (beatsWalking(from, to, start, best)) {
      expect(itinerary).toBeDefined()
      expect(itinerary!.end).toBeLessThanOrEqual(best + 1e-6)
    }
  }))
)

test("the reverse scan's latest departure still arrives in time", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const connections = buildConnections(runs, start)
    const itinerary = scan(feed, runs, connections, from, to, start)
    fc.pre(itinerary !== undefined && beatsWalking(from, to, start, itinerary.end))

    const leave = latestDeparture(feed, byArrival(connections), from, to, itinerary!.end)
    expect(leave).toBeGreaterThanOrEqual(itinerary!.start)
    expect(scan(feed, runs, connections, from, to, leave)!.end).toBeLessThanOrEqual(itinerary!.end + 1e-6)
  }))
)

test("plan suggests valid, distinct buses that feel better than walking, best first", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const itineraries = plan(feed, runs, from, to, start)
    const walking = walkOnly(from, to, start)

    expect(itineraries.length).toBeLessThanOrEqual(ALTERNATIVES)
    for (const itinerary of itineraries) {
      expectValid(feed, itinerary, from, to, start)
      expect(cost(itinerary, start)).toBeLessThan(cost(walking, start) - MIN_TIME_SAVED)
    }
    for (let i = 1; i < itineraries.length; i++)
      expect(cost(itineraries[i], start)).toBeGreaterThanOrEqual(cost(itineraries[i - 1], start))
    // None leaves earlier without arriving sooner than another
    for (const a of itineraries)
      for (const b of itineraries)
        if (a !== b)
          expect(a.start >= b.start && a.end <= b.end).toBe(a.start === b.start && a.end === b.end ? a === b : false)
  }))
)

test("live delays shift a trip's times", () =>
  fc.assert(fc.property(feed, fc.integer({ min: -300, max: 900 }), (feed, delay) => {
    const trip = feed.trips[0]
    // A stop visited twice gets the prediction matched to the nearer visit
    fc.pre(trip.stops.indexOf(trip.stops.at(-1)!) === trip.stops.length - 1)
    const stop = feed.stops[trip.stops.at(-1)!]
    const scheduled = serviceDayStart(TODAY) / 1000 + trip.times.at(-1)!
    const runs = buildRuns(feed, TODAY, [{
      serverTimestamp: 0,
      route: { id: "R", title: "R", color: "000000", textColor: "FFFFFF" },
      stop:  { id: stop.id, name: stop.name, code: stop.id },
      values: [{
        timestamp: (scheduled + delay) * 1000,
        minutes: 0,
        vehicleId: "V",
        tripId: trip.id,
        isDeparture: false,
        affectedByLayover: false,
        direction: { id: "", name: "", destinationName: "" }
      }]
    }])
    const run = runs.find(run => run.trip === trip && run.base === serviceDayStart(TODAY) / 1000)!
    expect(run.isLive).toBe(true)
    expect(timeAt(run, trip.stops.length - 1)).toBe(scheduled + delay)
  }))
)

test("trips Umo skips over while predicting their route aren't coming", () =>
  fc.assert(fc.property(feed, fc.nat(), (feed, pick) => {
    const trip = feed.trips[pick % feed.trips.length]
    const stop = feed.stops[trip.stops[0]]
    const predicted = BASE + trip.times[0]
    const runs = buildRuns(feed, TODAY, [{
      serverTimestamp: 0,
      route: { id: "R", title: "R", color: "000000", textColor: "FFFFFF" },
      stop:  { id: stop.id, name: stop.name, code: stop.id },
      values: [{
        timestamp: predicted * 1000,
        minutes: 0,
        vehicleId: "V",
        tripId: trip.id,
        isDeparture: true,
        affectedByLayover: true,
        direction: { id: "", name: "", destinationName: "" }
      }]
    }])

    for (const other of feed.trips)
      for (const base of [BASE - 86400, BASE, BASE + 86400]) {
        const isKept = runs.some(run => run.trip === other && run.base === base)
        const isPredicted = other === trip && base === BASE
        expect(isKept).toBe(isPredicted || base + other.times[0] > predicted)
      }
  }))
)
