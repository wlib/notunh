import { test, expect } from "vitest"
import fc from "fast-check"
import { canAlight, canBoard, serviceDayStart, withIndexes, type Feed, type FeedData, type Trip } from "../../src/map/feed.mts"
import { distance } from "../../src/geo/projection.mts"
import { type StopPredictions, forecastOf } from "../../src/map/umo.mts"
import { BOARDING, LAYOVER, type Run, arrivalAt, buildRuns as runsOf, slack, spread, timeAt, uncertainty } from "../../src/map/forecast.mts"
import {
  ALTERNATIVES, HORIZON, MIN_TIME_SAVED, MIN_TRANSFER_GAIN,
  buildConnections, cost, itineraryKey, plan, rides, scan, walkOnly,
  type Itinerary, type Place
} from "../../src/map/plan.mts"
import {
  MAX_ACCESS_WALK, MAX_TRANSFER_WALK, createWalks, straightMeters, walkAllowance, walkSeconds, type Walks
} from "../../src/map/walks.mts"
import { emptyModel, holdProbability, isLikely, probit, update } from "../../src/map/model.mts"
import type { Visit } from "../../src/map/events.mts"
import { type Day, addDays } from "../../src/shared/time.mts"

// The planner properties are cheap and the interesting cases are rare, so look harder
fc.configureGlobal({ numRuns: 1000 })
const TODAY = "2026-10-01"
const BASE = serviceDayStart(TODAY) / 1000
const CENTER = { lat: 43.135, lon: -70.93 }

// Integers, since fc.double favors edge cases like 0 that would pile every stop in one spot
const offset = (place: { lat: number, lon: number }, size: number) =>
  fc
    .tuple(fc.integer({ min: -size, max: size }), fc.integer({ min: -size, max: size }))
    .map(([lat, lon]): Place => ({ lat: place.lat + lat * 1e-5, lon: place.lon + lon * 1.4e-5, name: "" }))

// Spread over several km, so riding beats walking and transfers matter
const near = offset(CENTER, 8000)

// Small feeds: a few stops within a few km, a few trips that may revisit stops like loops do, wait at some stops
// before leaving, and let nobody on or off at some
const feed = fc
  .array(near, { minLength: 2, maxLength: 8 })
  .chain(stops =>
    fc.record({
      stops: fc.constant(stops),
      trips: fc.array(
        fc.record({
          stops: fc.array(fc.nat(stops.length - 1), { minLength: 2, maxLength: 6 }),
          first: fc.integer({ min: 7 * 3600, max: 11 * 3600 }),
          gaps:  fc.array(fc.nat({ max: 300 }), { minLength: 8, maxLength: 8 }),
          waits: fc.array(fc.nat({ max: 90 }), { minLength: 8, maxLength: 8 }),
          timepoints: fc.uniqueArray(fc.nat(5), { maxLength: 3 }),
          noPickup:   fc.uniqueArray(fc.nat(5), { maxLength: 2 }),
          noDropOff:  fc.uniqueArray(fc.nat(5), { maxLength: 2 })
        }),
        { minLength: 1, maxLength: 8 }
      )
    })
  )
  .map(({ stops, trips }): Feed => {
    const data: FeedData = {
      version: "test",
      start: "2000-01-01",
      end: "2099-12-31",
      routes: [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
      stops: stops.map((stop, i) => ({ ...stop, id: `${i}`, name: `Stop ${i}` })),
      services: { daily: { days: 127, start: "2000-01-01", end: "2099-12-31", added: [], removed: [] } },
      trips: trips.map((trip, i) => {
        const last = trip.stops.length - 1
        const positions = (among: number[], isMeaningful: (position: number) => boolean) =>
          among.filter(position => position <= last && isMeaningful(position)).sort((a, b) => a - b)
        // Getting to each stop a gap after leaving the one before, and leaving it after waiting there
        const arrivals: number[] = []
        const times: number[] = []
        trip.stops.forEach((_, j) => {
          arrivals.push(j === 0 ? trip.first : times[j - 1] + trip.gaps[j - 1])
          times.push(arrivals[j] + (j === 0 ? 0 : trip.waits[j - 1]))
        })
        const noPickup = positions(trip.noPickup, position => position < last)
        const noDropOff = positions(trip.noDropOff, position => position > 0)
        return {
          id: `T${i}`,
          route: "R",
          service: "daily",
          headsign: "",
          shape: "",
          stops: trip.stops,
          times,
          ...arrivals.some((arrival, j) => arrival !== times[j]) ? { arrivals } : {},
          ...noPickup.length ? { noPickup } : {},
          ...noDropOff.length ? { noDropOff } : {},
          timepoints: positions(trip.timepoints, () => true)
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

// The earliest arrival over every itinerary with at most two rides (or one), by brute force, leaving each boarding
// the slack the planner needs: a walk's allowance, how unsure getting off the last bus is, and the bus's own
const bruteForce = (feed: Feed, runs: Run[], from: Place, to: Place, start: number, maxRides = 2) => {
  let best = Infinity
  const stops = feed.stops

  const finish = (stop: number, time: number) => {
    if (straightMeters(stops[stop], to) <= MAX_ACCESS_WALK)
      best = Math.min(best, time + walkSeconds(straightMeters(stops[stop], to)))
    stops.forEach((other, i) => {
      const meters = straightMeters(stops[stop], other)
      if (i !== stop && meters <= MAX_TRANSFER_WALK && straightMeters(other, to) <= MAX_ACCESS_WALK)
        best = Math.min(best, time + walkSeconds(meters) + walkSeconds(straightMeters(other, to)))
    })
  }

  const rides = function * (ready: (stop: number) => number) {
    for (const run of runs)
      for (let i = 0; i < run.trip.stops.length; i++)
        for (let j = i + 1; j < run.trip.stops.length; j++)
          if (
            canBoard(run.trip, i) && canAlight(run.trip, j) &&
            timeAt(run, i) >= ready(run.trip.stops[i]) + slack(run, i, timeAt(run, i), start) &&
            timeAt(run, i) >= start &&
            timeAt(run, j - 1) <= start + HORIZON
          )
            yield { run, alight: run.trip.stops[j], arrival: arrivalAt(run, j) }
  }

  const access = (stop: number) =>
    straightMeters(from, stops[stop]) <= MAX_ACCESS_WALK
      ? start + walkAllowance(straightMeters(from, stops[stop]), "estimate")
      : Infinity

  for (const first of rides(access)) {
    finish(first.alight, first.arrival)
    if (maxRides < 2)
      continue

    const ready = first.arrival + uncertainty(first.arrival - start)
    const transfer = (stop: number) => {
      const meters = straightMeters(stops[first.alight], stops[stop])
      return (
        stop === first.alight       ? ready :
        meters <= MAX_TRANSFER_WALK ? ready + walkAllowance(meters, "estimate") :
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
  // The earliest the next bus can be counted on to be caught, with the slack it needs on top
  let ready = itinerary.start
  let previousRun: Run | undefined
  for (const leg of itinerary.legs) {
    expect(leg.start).toBeGreaterThanOrEqual(time)
    if (leg.kind === "walk") {
      expect(distance(at, leg.from)).toBe(0)
      expect(leg.meters).toBeCloseTo(straightMeters(leg.from, leg.to), 3)
      expect(leg.end - leg.start).toBe(walkSeconds(leg.meters))
      ready += walkAllowance(leg.meters, "estimate")
      at = leg.to
    }
    else {
      const { run, fromPosition, toPosition } = leg
      expect(fromPosition).toBeLessThan(toPosition)
      // Never on where the stop time says nobody gets on, nor off where nobody gets off
      expect(canBoard(run.trip, fromPosition)).toBe(true)
      expect(canAlight(run.trip, toPosition)).toBe(true)
      expect(distance(at, feed.stops[run.trip.stops[fromPosition]])).toBe(0)
      expect(leg.start).toBe(timeAt(run, fromPosition))
      expect(leg.end).toBe(arrivalAt(run, toPosition))
      if (run !== previousRun)
        expect(leg.start).toBeGreaterThanOrEqual(ready + slack(run, fromPosition, leg.start, start) - 1e-6)
      previousRun = run
      ready = leg.end + uncertainty(leg.end - start)
      at = feed.stops[run.trip.stops[toPosition]]
    }
    time = leg.end
  }
  expect(distance(at, to)).toBe(0)
}

// Walking in straight lines, as the planner does without a network, the same object for each feed
const walksCache = new WeakMap<Feed, Walks>()
const walksOf = (feed: Feed) => {
  if (!walksCache.has(feed))
    walksCache.set(feed, createWalks(feed.stops))
  return walksCache.get(feed)!
}

// Rounding walk times to the second can make a detour via a stop look a second or two quicker
const beatsWalking = (feed: Feed, from: Place, to: Place, start: number, end: number) =>
  end < walkOnly(walksOf(feed), from, to, start).end - 2

// When riding only ties walking somewhere along the way, scan rightly prefers walking there,
// which is the walk-only option and not a bus itinerary, so these properties are about buses that help
test("scan finds valid itineraries, with the slack every boarding needs, at least as early as any with two rides", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const itinerary = scan(feed, walksOf(feed), runs, buildConnections(runs, start), from, to, start, { now: start })
    const best = bruteForce(feed, runs, from, to, start)

    if (itinerary)
      expectValid(feed, itinerary, from, to, start)
    if (beatsWalking(feed, from, to, start, best)) {
      expect(itinerary).toBeDefined()
      expect(itinerary!.end).toBeLessThanOrEqual(best + 1e-6)
    }
  }))
)

test("plan suggests valid, distinct buses that feel better than walking, best first", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const itineraries = plan(feed, walksOf(feed), runs, from, to, start)
    const walking = walkOnly(walksOf(feed), from, to, start)
    const buses = (itinerary: Itinerary) =>
      itinerary.legs.flatMap(leg => leg.kind === "ride" ? [leg.run] : [])

    expect(itineraries.length).toBeLessThanOrEqual(ALTERNATIVES)
    for (const itinerary of itineraries) {
      expectValid(feed, itinerary, from, to, start)
      expect(cost(itinerary, start)).toBeLessThan(cost(walking, start) - MIN_TIME_SAVED)
    }
    for (let i = 1; i < itineraries.length; i++)
      expect(cost(itineraries[i], start)).toBeGreaterThanOrEqual(cost(itineraries[i - 1], start))
    for (const a of itineraries)
      for (const b of itineraries)
        if (a !== b)
          expect(buses(a)).not.toEqual(buses(b))
  }))
)

test("plan only changes buses to arrive well before one bus or walking could", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const simpler = Math.min(bruteForce(feed, runs, from, to, start, 1), walkOnly(walksOf(feed), from, to, start).end)
    for (const itinerary of plan(feed, walksOf(feed), runs, from, to, start))
      if (rides(itinerary) > 1)
        expect(itinerary.end + MIN_TRANSFER_GAIN).toBeLessThanOrEqual(simpler + 1e-6)
  }))
)

/** The same feed with its stops in another order, keeping their ids, as a newer timetable may number them */
const renumbered = (feed: Feed, seed: number) => {
  const order = feed.stops.map((_, i) => i).sort((a, b) => (a * 7919 + seed) % 1009 - (b * 7919 + seed) % 1009 || a - b)
  const index = new Map(order.map((was, now) => [was, now]))
  return withIndexes({
    ...feed,
    stops: order.map(i => feed.stops[i]),
    trips: feed.trips.map(trip => ({ ...trip, stops: trip.stops.map(stop => index.get(stop)!) }))
  })
}

/** The stops an itinerary gets on and off at, by id */
const stopsOf = (feed: Feed, itinerary: Itinerary) =>
  itinerary.legs.flatMap(leg => leg.kind === "ride" ? [leg.fromPosition, leg.toPosition].map(position => feed.stops[leg.run.trip.stops[position]].id) : [])

test("a timetable with its stops numbered otherwise plans the same itineraries, by the same stops", () =>
  fc.assert(fc.property(scenario, fc.nat(), ({ feed, from, to, start }, seed) => {
    const other = renumbered(feed, seed)
    const before = plan(feed, walksOf(feed), buildRuns(feed, TODAY, []), from, to, start)
    const after = plan(other, walksOf(other), buildRuns(other, TODAY, []), from, to, start)
    expect(after.map(itineraryKey)).toEqual(before.map(itineraryKey))
    expect(after.map(itinerary => stopsOf(other, itinerary))).toEqual(before.map(itinerary => stopsOf(feed, itinerary)))
  }))
)

test("plan's best option feels no worse than catching a bus from a nearer stop", () =>
  fc.assert(fc.property(scenario, ({ feed, from, to, start }) => {
    const runs = buildRuns(feed, TODAY, [])
    const connections = buildConnections(runs, start)
    const [best] = plan(feed, walksOf(feed), runs, from, to, start)
    const quickest = scan(feed, walksOf(feed), runs, connections, from, to, start, { now: start, direct: true })
    fc.pre(best !== undefined && quickest !== undefined)

    const meters = quickest!.legs[0].kind === "walk" ? quickest!.legs[0].meters : 0
    const walking = cost(walkOnly(walksOf(feed), from, to, start), start)
    feed.stops.forEach((stop, access) => {
      if (straightMeters(from, stop) >= meters)
        return
      const nearer = scan(feed, walksOf(feed), runs, connections, from, to, start, { now: start, direct: true, access })
      if (nearer && cost(nearer, start) < walking - MIN_TIME_SAVED)
        expect(cost(best, start)).toBeLessThanOrEqual(cost(nearer, start) + 1e-6)
    })
  }))
)

/** The day's runs, as Umo's predictions forecast them, answered at an epoch second, by default before anything here */
const buildRuns = (feed: Feed, today: Day, predictions: StopPredictions[], model?: Parameters<typeof runsOf>[3], at = -Infinity) =>
  runsOf(feed, today, forecastOf(predictions, at), model)

/** Umo predicting a trip's bus at one of its stops */
const predict = (stop: { id: string }, tripId: string, at: number, isLive = true): StopPredictions => ({
  route: { id: "R" },
  stop:  { id: stop.id },
  values: [{
    timestamp: at * 1000,
    minutes: 0,
    vehicleId: "V",
    tripId,
    affectedByLayover: !isLive,
    direction: { name: "" }
  }]
})

/** A feed of trips along the same stops, at their own times and timepoints, and whatever else each says */
const lineFeed = (trips: ({ times: number[], timepoints: number[] } & Partial<Trip>)[]) =>
  withIndexes({
    version: "test",
    start: "2000-01-01",
    end: "2099-12-31",
    routes: [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
    stops: trips[0].times.map((_, i) => ({ ...CENTER, lat: CENTER.lat + i * 0.01, id: `${i}`, name: `Stop ${i}` })),
    services: { daily: { days: 127, start: "2000-01-01", end: "2099-12-31", added: [], removed: [] } },
    trips: trips.map(({ times, ...rest }, i) => ({
      id: `T${i}`, route: "R", service: "daily", headsign: "", shape: "", stops: times.map((_, j) => j), times, ...rest
    })),
    shapes: {}
  })

test("nobody boards an arrivals-only stop, even when it's the only one in reach", () => {
  const times = [8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200]
  const from = { ...CENTER, lat: CENTER.lat + 0.0001, name: "" }
  const to = { ...CENTER, lat: CENTER.lat + 0.02, name: "" }
  const open = lineFeed([{ times, timepoints: [] }])
  const closed = lineFeed([{ times, timepoints: [], noPickup: [0] }])
  const at = (feed: Feed) => plan(feed, createWalks(feed.stops), buildRuns(feed, TODAY, []), from, to, BASE + times[0] - 300)
  expect(at(open).map(itinerary => stopsOf(open, itinerary))).toEqual([["0", "2"]])
  expect(at(closed)).toEqual([])
})

test("a bus that waits at a stop gets there before it leaves, and a ride ends on getting there", () => {
  const times = [8 * 3600, 8 * 3600 + 700, 8 * 3600 + 1200]
  const arrivals = [8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200]
  const feed = lineFeed([{ times, arrivals, timepoints: [] }])
  const run = runOn(buildRuns(feed, TODAY, []), "T0")
  expect(arrivalAt(run, 1)).toBe(BASE + arrivals[1])
  expect(timeAt(run, 1)).toBe(BASE + times[1])
  const from = { ...CENTER, lat: CENTER.lat + 0.0001, name: "" }
  const to = { ...CENTER, lat: CENTER.lat + 0.0101, name: "" }
  const [itinerary] = plan(feed, createWalks(feed.stops), buildRuns(feed, TODAY, []), from, to, BASE + times[0] - 300)
  expect(itinerary.legs[1]).toMatchObject({ kind: "ride", start: BASE + times[0], end: BASE + arrivals[1] })
})

const runOn = (runs: Run[], trip: string) =>
  runs.find(run => run.trip.id === trip && run.base === BASE)!

test("live delays shift a trip's times", () =>
  fc.assert(fc.property(feed, fc.integer({ min: -300, max: 900 }), (feed, delay) => {
    const trip = feed.trips[0]
    // A stop visited twice gets the prediction matched to the nearer visit
    fc.pre(trip.stops.indexOf(trip.stops.at(-1)!) === trip.stops.length - 1)
    const stop = feed.stops[trip.stops.at(-1)!]
    const scheduled = serviceDayStart(TODAY) / 1000 + trip.times.at(-1)!
    // An early bus would hold at a timepoint on the way, and be on time from there on
    fc.pre(delay >= 0 || trip.timepoints.length === 0)
    const runs = buildRuns(feed, TODAY, [predict(stop, trip.id, scheduled + delay)])
    const run = runs.find(run => run.trip === trip && run.base === serviceDayStart(TODAY) / 1000)!
    expect(run.isLive).toBe(true)
    expect(timeAt(run, trip.stops.length - 1)).toBe(scheduled + delay)
  }))
)

test("trips Umo skips over at a stop it's predicting aren't coming, and only those, as a far look ahead at one stop says nothing of another", () =>
  fc.assert(fc.property(feed, fc.nat(), (feed, pick) => {
    const trip = feed.trips[pick % feed.trips.length]
    const stop = feed.stops[trip.stops[0]]
    const predicted = BASE + trip.times[0]
    const runs = buildRuns(feed, TODAY, [predict(stop, trip.id, predicted, false)])

    for (const other of feed.trips)
      for (const base of [BASE - 86400, BASE, BASE + 86400]) {
        const isKept = runs.some(run => run.trip === other && run.base === base)
        const isPredicted = other === trip && base === BASE
        // Answered before anything here, so each run may be off by the most a time can be
        const isMissed = other.stops.some((at, position) => feed.stops[at].id === stop.id && base + other.times[position] <= predicted - uncertainty(Infinity))
        expect(isKept).toBe(isPredicted || !isMissed)
      }
  }))
)

test("a bus due at a stop before Umo answered for it isn't taken as not coming for being missing there, as it's been and gone", () => {
  const feed = lineFeed([0, 1].map(hour => ({ times: [8 + hour, 8.1 + hour, 8.2 + hour].map(time => time * 3600), timepoints: [] })))
  // Umo answers at 8:05, after T0 left stop 0, with T1 there at 9:00
  const runs = buildRuns(feed, TODAY, [predict(feed.stops[0], "T1", BASE + 9 * 3600)], undefined, BASE + 8 * 3600 + 300)
  expect(runOn(runs, "T0")).toBeDefined()
  // Answered before T0 was due, its missing there is news
  expect(runOn(buildRuns(feed, TODAY, [predict(feed.stops[0], "T1", BASE + 9 * 3600)], undefined, BASE + 7 * 3600), "T0")).toBeUndefined()
})

test("Umo looking ahead at a stop says a run isn't coming only through a trip it names, and only for a run due there sooner than it may be running late", () => {
  const feed = lineFeed([8, 8 + 58 / 60, 9].map(hour => ({ times: [hour * 3600, hour * 3600 + 600], timepoints: [] })))
  const answered = BASE + 7 * 3600
  const tripless = predict(feed.stops[0], "T2", BASE + 9 * 3600)
  tripless.values[0].tripId = null
  // A prediction without a trip says nothing of which runs aren't coming
  expect(runOn(buildRuns(feed, TODAY, [tripless], undefined, answered), "T0")).toBeDefined()
  // T2 at 9:00 is news that T0, due an hour before, isn't coming, but T1, due two minutes before, may just be late
  const runs = buildRuns(feed, TODAY, [predict(feed.stops[0], "T2", BASE + 9 * 3600)], undefined, answered)
  expect(runOn(runs, "T0")).toBeUndefined()
  expect(runOn(runs, "T1")).toBeDefined()
})

test("an early bus waits at a timepoint for its scheduled time, and a late one goes straight on", () =>
  fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: -600, max: 600 }), (timepoint, delay) => {
    const times = [8, 9, 10, 11, 12, 13].map(hour => hour * 3600)
    const feed = lineFeed([{ times, timepoints: [timepoint] }])
    const run = runOn(buildRuns(feed, TODAY, [predict(feed.stops[0], "T0", BASE + times[0] + delay)]), "T0")
    times.forEach((_, position) => {
      const isHeld = delay < 0 && position >= timepoint
      expect(run.delays[position]).toBe(isHeld ? 0 : delay)
      expect(run.holds[position]).toBe(isHeld && position === timepoint ? -delay : 0)
    })
  }))
)

test("a connector's next loop starts a layover after its bus gets in, unless it waits for its scheduled start", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 1800 }), fc.boolean(), (gap, waits) => {
    // The bus is on T0, which ends at 9:00, and Umo has its next loop, T1, starting on schedule
    const feed = lineFeed([
      { times: [8 * 3600, 9 * 3600], timepoints: [] },
      { times: [9 * 3600 + LAYOVER + gap, 10 * 3600 + LAYOVER + gap], timepoints: waits ? [0] : [] }
    ])
    const runs = buildRuns(feed, TODAY, [
      predict(feed.stops[1], "T0", BASE + 9 * 3600),
      predict(feed.stops[0], "T1", BASE + 9 * 3600 + LAYOVER + gap, false)
    ])
    expect(timeAt(runOn(runs, "T1"), 0)).toBe(BASE + 9 * 3600 + LAYOVER + (waits ? gap : 0))
  }))
)

test("with an empty model, how far off a bus may be is as it always was, less the chance it waits for its time", () =>
  fc.assert(fc.property(feed, fc.integer({ min: -600, max: 4 * 3600 }), fc.boolean(), (feed, lead, isLive) => {
    const runs = buildRuns(feed, TODAY, [])
    for (const run of runs.slice(0, 5)) {
      run.isLive = isLive
      run.trip.stops.forEach((_, position) => {
        const time = timeAt(run, position)
        const now = time - lead
        expect(spread(run, position, time, now)).toBe(uncertainty(lead))
        // The timetable's own word on waiting is the prior, and the slack covers the rest of the ways it might leave
        const waits = holdProbability(emptyModel(), "R", "", run.trip.timepoints.includes(position))
        const share = probit((0.85 - waits) / (1 - waits)) / probit(0.85)
        expect(slack(run, position, time, now)).toBeCloseTo(Math.max(BOARDING, uncertainty(lead) * (isLive ? 1 : 2) * share), 6)
      })
    }
  }))
)

test("a bus as likely as not to wait for its time gets the slack of one that doesn't, and a sure one a boarding's", () => {
  const times = [8 * 3600, 9 * 3600, 10 * 3600]
  const feed = lineFeed([{ times, timepoints: [1] }])
  const [run] = buildRuns(feed, TODAY, [])
  const now = BASE + times[1] - 600
  const at = (holdChance: number[], delays = [0, 0, 0]) => slack({ ...run, holdChance, delays }, 1, BASE + times[1] + delays[1], now)
  expect(at([0, 0.5, 0])).toBeGreaterThan(at([0, 0, 0]) * 0.5)
  expect(at([0, 0.9, 0])).toBe(BOARDING)
  // Running late, it isn't waiting for anything
  expect(at([0, 0.9, 0], [60, 60, 60])).toBe(at([0, 0, 0], [60, 60, 60]))
})

/** A model that's seen a day of buses on route R drive between each pair of its stops in some seconds */
const learned = (feed: Feed, seconds: number[], extra: Visit[] = []) =>
  update(emptyModel(), addDays(TODAY, -1), [
    ...feed.trips[0].stops.slice(1).map((stop, i): Visit => ({
      vehicle: "V", route: "R", stop: feed.stops[stop].id, arrive: BASE + seconds[i % seconds.length], depart: BASE + seconds[i % seconds.length] + 10,
      from: feed.stops[feed.trips[0].stops[i]].id, meters: 1000, left: BASE
    })),
    ...extra
  ])

test("for a tracked bus, a learned model leaves more slack the further along its trip the stop is", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: 30, max: 600 }), { minLength: 1, maxLength: 5 }), fc.integer({ min: 0, max: 3 }), (seconds, delay) => {
    const times = [8, 9, 10, 11, 12, 13].map(hour => hour * 3600)
    const feed = lineFeed([{ times, timepoints: [] }])
    const model = learned(feed, seconds)
    const run = runOn(buildRuns(feed, TODAY, [predict(feed.stops[0], "T0", BASE + times[0] + delay)], model), "T0")
    const now = BASE + times[0] - 60
    const spreads = times.map((_, position) => spread(run, position, timeAt(run, position), now))
    spreads.slice(1).forEach((value, i) => expect(value).toBeGreaterThanOrEqual(spreads[i]))
    for (const value of spreads) {
      expect(value).toBeGreaterThanOrEqual(BOARDING)
      expect(value).toBeLessThanOrEqual(uncertainty(Infinity))
    }
  }))
)

test("a stop where buses turn out to wait for their time is held at, and the layover learned replaces the default", () =>
  fc.assert(fc.property(fc.integer({ min: 30, max: 900 }), layover => {
    const times = [8, 9, 10].map(hour => hour * 3600)
    const feed = lineFeed([{ times, timepoints: [] }, { times: times.map(time => time + 3 * 3600), timepoints: [] }])
    const waited = Array.from({ length: 20 }, (_, i): Visit => ({
      vehicle: `V${i}`, route: "R", stop: "1", arrive: BASE - 600, depart: BASE, trip: "T0", position: 1, isEnd: false, scheduled: BASE
    }))
    const model = learned(feed, [60], [...waited, { vehicle: "W", route: "R", stop: "0", arrive: BASE, depart: BASE, gotIn: BASE - layover }])
    const [run] = buildRuns(feed, TODAY, [], model)
    expect(run.holdChance.map(isLikely)).toEqual([false, true, false])
    // The bus on T0 gets in at 10:00, and Umo has T1 starting on schedule much later
    const runs = buildRuns(feed, TODAY, [
      predict(feed.stops[2], "T0", BASE + times[2]),
      predict(feed.stops[0], "T1", BASE + times[0] + 3 * 3600, false)
    ], model)
    expect(timeAt(runOn(runs, "T1"), 0)).toBeCloseTo(BASE + times[2] + layover, -1)
  }))
)
