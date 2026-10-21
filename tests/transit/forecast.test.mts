import { test, expect } from "vitest"
import fc from "fast-check"
import { serviceDayStart, withIndexes, type Trip } from "../../src/transit/feed.mts"
import type { Visit } from "../../src/transit/inference/events.mts"
import { NO_FORECAST } from "../../src/transit/observations/predictions.mts"
import { type Run, type Sighting, buildRuns, spread } from "../../src/transit/models/forecast.mts"
import { NO_PACE } from "../../src/transit/models/movement.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { update } from "../../src/transit/models/fit.mts"
import { zoneEstimate } from "../../src/transit/models/estimates.mts"
import { forecastOf } from "../../src/transit/observations/umo.mts"
import { lineOf, positionsOf } from "../../src/transit/shapes.mts"
import { buildConnections } from "../../src/routing/plan.mts"
import { addDays } from "../../src/shared/time.mts"

const TODAY = "2026-10-01"
const BASE = serviceDayStart(TODAY) / 1000
const CENTER = { lat: 43.135, lon: -70.93 }

/**
 * Trips of route R along stops a kilometer or so apart, at their own times, the last ending where the first starts
 * for loops
 */
const lineFeed = (trips: ({ times: number[] } & Partial<Trip>)[], isLoop = false) =>
  withIndexes({
    version: "test",
    start: "2000-01-01",
    end: "2099-12-31",
    routes: [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
    stops: trips[0].times.map((_, i) => ({ ...CENTER, lat: CENTER.lat + i * 0.01, id: `${i}`, name: `Stop ${i}` })),
    services: { daily: { days: 127, start: "2000-01-01", end: "2099-12-31", added: [], removed: [] } },
    trips: trips.map(({ times, ...rest }, i) => ({
      id: `T${i}`, route: "R", service: "daily", headsign: "", shape: "", timepoints: [],
      stops: times.map((_, j) => isLoop && j === times.length - 1 ? 0 : j), times, ...rest
    })),
    shapes: {}
  })

const runOn = (runs: Run[], trip: string) =>
  runs.find(run => run.trip.id === trip && run.base === BASE)!

const hours = (...of: number[]) =>
  of.map(hour => BASE + hour * 3600 - BASE)

/** A bus seen at a stop, there since some epoch second, or having left it then */
const seen = (stop: string, at: number, isThere: boolean, extra: Partial<Sighting> = {}): Sighting => ({
  vehicleId: "V", tripId: "T0", stop, arrive: at - 30, ...!isThere && { depart: at }, pace: NO_PACE, at, ...extra
})

/** A model that's seen route R's buses take some seconds between each pair of stops, at each, and running some seconds late */
const learned = (legs: number, dwell: number, late = 0, extra: Visit[] = []) =>
  update(emptyModel(), addDays(TODAY, -1), [...extra, ...Array.from({ length: 5 }, (_, i): Visit[] => [
    { vehicle: `V${i}`, route: "R", stop: `${i}`, arrive: BASE + 36000, depart: BASE + 36000 + dwell, position: i + 1, trip: "T0", scheduled: BASE + 36000 + dwell - late },
    { vehicle: `V${i}`, route: "R", stop: `${i + 1}`, arrive: BASE + 36000 + dwell + legs, depart: BASE + 36000 + 2 * dwell + legs, from: `${i}`, meters: 1000, left: BASE + 36000 + dwell, position: i + 2, trip: "T0", scheduled: BASE + 36000 + 2 * dwell + legs - late }
  ]).flat()])

test("a bus the map follows is forecast along its trip from where it was seen, and Umo, which it outranks there, still says which runs aren't coming", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.integer({ min: -600, max: 900 }), (position, isThere, late) => {
    const feed = lineFeed([{ times: hours(10, 10.1, 10.2, 10.3, 10.4, 10.5) }, { times: hours(9, 9.1, 9.2, 9.3, 9.4, 9.5) }])
    const model = learned(300, 30)
    const at = BASE + 36000 + position * 360 + late
    // Umo says the bus is somewhere else entirely, and covers the stop T1 was due at in the past two hours
    const forecast = forecastOf([{ route: { id: "R" }, stop: { id: "5" }, values: [{ timestamp: (at + 5000) * 1000, vehicleId: "V", tripId: "T0", affectedByLayover: false }] }], at - 7200)
    const runs = buildRuns(feed, TODAY, forecast, model, [seen(`${position}`, at, isThere)])
    const run = runOn(runs, "T0")
    expect(run.isLive && run.tracked && run.vehicle === "V").toBeTruthy()
    for (let i = position + 1; i < 6; i++) {
      expect(run.departures[i]).toBeGreaterThan(run.departures[i - 1])
      expect(run.departures[i]).toBeLessThan(at + 5000)
    }
    // Where it had been by then
    for (let i = 0; i < position; i++)
      expect(run.departures[i]).toBeLessThanOrEqual(at)
    expect(runOn(runs, "T1")).toBeUndefined()
  }))
)

test("with no bus followed on it, a run is its timetable shifted by how late its route runs, which only Umo having a bus on it moves, or with nothing learned, Umo's schedule too", () =>
  fc.assert(fc.property(fc.integer({ min: -300, max: 600 }), fc.integer({ min: -900, max: 900 }), fc.boolean(), (late, umo, isLive) => {
    const feed = lineFeed([{ times: hours(10, 10.1, 10.2) }])
    const forecast = forecastOf([{ route: { id: "R" }, stop: { id: "2" }, values: [{ timestamp: (BASE + 36720 + umo) * 1000, vehicleId: "V", tripId: "T0", affectedByLayover: !isLive }] }], -Infinity)
    const known = runOn(buildRuns(feed, TODAY, forecast, learned(300, 30, late)), "T0")
    expect(known.vehicle).toBe("V")
    expect(known.departures[2] - (BASE + 36720)).toBeCloseTo(isLive ? umo : late, 2)
    expect(runOn(buildRuns(feed, TODAY, forecast, emptyModel()), "T0").departures[2]).toBe(BASE + 36720 + umo)
  }))
)

test("a route that keeps to its timetable is back on it half an hour ahead, however late the bus is now", () => {
  const times = hours(10, 10.25, 10.5, 10.75, 11, 11.25)
  const feed = lineFeed([{ times, timepoints: [0, 3] }])
  // A bus an hour late at the first stop, with legs taking a quarter of an hour
  const runs = buildRuns(feed, TODAY, NO_FORECAST, learned(900, 0), [seen("0", BASE + times[0] + 3600, true)])
  const run = runOn(runs, "T0")
  expect(run.departures[1] - (BASE + times[1])).toBeGreaterThan(1800)
  expect(run.departures[5]).toBeCloseTo(BASE + times[5], -1)
})

test("a loop's bus goes on into the loops after, each starting where the one before ends after a layover there, as far as an hour or so ahead, and only one bus runs a loop", () =>
  fc.assert(fc.property(fc.integer({ min: 60, max: 850 }), fc.boolean(), (layover, isTaken) => {
    // Loops starting every 20 minutes from 10:00, each 15 minutes long, with layovers learned at their first stop
    const feed = lineFeed(Array.from({ length: 6 }, (_, i) => ({ times: [0, 300, 600, 900].map(s => 36000 + i * 1200 + s) })), true)
    const model = learned(300, 0, 0, Array.from({ length: 10 }, (_, i): Visit =>
      ({ vehicle: `L${i}`, route: "R", stop: "0", arrive: BASE, depart: BASE + layover, position: 0, trip: "T0" })
    ))
    expect(zoneEstimate(model, "R", "0", true)?.mean).toBeCloseTo(layover, 0)
    // A bus on T0's second stop, and maybe another already on the loop it would run next
    const alone = buildRuns(feed, TODAY, NO_FORECAST, model, [seen("1", BASE + 36300, false)])
    const own = alone.filter(run => run.vehicle === "V").sort((a, b) => a.trip.times[0] - b.trip.times[0])
    expect(own[0]).toBe(runOn(alone, "T0"))
    expect(own.length).toBeGreaterThanOrEqual(3)
    own.slice(1).forEach((next, i) => {
      // It leaves each next loop's first stop a layover after it gets in at the end of the one before, and only the
      // loop it's seen on is live
      expect(next.trip.id).toBe(`T${i + 1}`)
      expect(next.departures[0] - own[i].departures[3]).toBeCloseTo(layover, -1)
      expect(next.isLive).toBe(false)
      expect(next.tracked).toBeDefined()
    })
    // Beyond about an hour ahead, a loop is its timetable
    for (const run of alone.filter(run => run.base === BASE && run.vehicle === undefined))
      expect(run.departures[0] - run.trip.times[0] - BASE).toBe(0)
    if (isTaken) {
      const taken = seen("1", own[1].departures[1], false, { vehicleId: "W", tripId: own[1].trip.id })
      const runs = buildRuns(feed, TODAY, NO_FORECAST, model, [seen("1", BASE + 36300, false), taken])
      expect(runOn(runs, own[1].trip.id).vehicle).toBe("W")
      expect(runs.filter(run => run.vehicle === "V").map(run => run.trip.id)).not.toContain(own[1].trip.id)
    }
  }))
)

test("a loop's bus goes on only into a loop of its own service day due to start about when it would, and isn't live on it until seen there", () =>
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 960, max: 6 * 3600 }), { maxLength: 3 }),
    fc.nat(3),
    fc.integer({ min: 1, max: 2 }),
    fc.integer({ min: -120, max: 900 }),
    (gaps, which, position, late) => {
      // Sparse loops, each 15 minutes long, the last of the day at 22:00, every day
      const starts = gaps.reduceRight((after, gap) => [after[0] - gap, ...after], [79200])
      const feed = lineFeed(starts.map(start => ({ times: [0, 300, 600, 900].map(s => start + s) })), true)
      const on = Math.min(which, starts.length - 1)
      const at = BASE + starts[on] + position * 300 + late
      const runs = buildRuns(feed, TODAY, NO_FORECAST, learned(300, 0), [seen(`${position}`, at, false, { tripId: `T${on}` })])
      const own = runOn(runs, `T${on}`)
      expect(runs.filter(run => run.isLive)).toEqual([own])
      for (const run of runs.filter(run => run !== own)) {
        const scheduled = run.base + run.trip.times[0]
        if (run.vehicle === undefined)
          expect(run.departures[0]).toBe(scheduled)
        else {
          // Only a later loop of today's, each due to start at most half an hour after the loop before it is due to
          // end, or a minute before
          expect(run.base).toBe(BASE)
          expect(run.trip.times[0]).toBeGreaterThan(starts[on])
          const loop = starts.indexOf(run.trip.times[0])
          expect(starts[loop] - (starts[loop - 1] + 900)).toBeGreaterThanOrEqual(-60)
          expect(starts[loop] - (starts[loop - 1] + 900)).toBeLessThanOrEqual(1800)
        }
      }
    }
  ))
)

test("of two buses tagged with one trip, the one nearer its time runs it, and the other's on a loop after it", () => {
  const feed = lineFeed([{ times: hours(10, 10.1, 10.2, 10.3) }])
  const runs = buildRuns(feed, TODAY, NO_FORECAST, learned(300, 0), [
    seen("1", BASE + 36360 + 2400, false, { vehicleId: "stale" }),
    seen("1", BASE + 36360 + 60, false)
  ])
  expect(runOn(runs, "T0").vehicle).toBe("V")
})

test("a followed bus's spread grows the further along it is, within what a planner can count on", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), position => {
    const feed = lineFeed([{ times: hours(10, 10.1, 10.2, 10.3, 10.4, 10.5) }])
    const at = BASE + 36000 + position * 360
    const run = runOn(buildRuns(feed, TODAY, NO_FORECAST, learned(300, 30), [seen(`${position}`, at, false)]), "T0")
    const spreads = run.trip.stops.map((_, i) => spread(run, i, run.departures[i], at)).slice(position)
    spreads.slice(1).forEach((value, i) => expect(value).toBeGreaterThanOrEqual(spreads[i]))
  }))
)

test("a bus at the stop its loop starts and ends at is starting the trip it's tagged with, however late, which measured best on held-out data", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 1500 }), late => {
    const feed = lineFeed([{ times: [0, 300, 600, 900].map(s => 36000 + s) }], true)
    const at = BASE + 36000 + late
    const run = runOn(buildRuns(feed, TODAY, NO_FORECAST, learned(300, 0), [seen("0", at, true)]), "T0")
    expect(run.tracked).toBeDefined()
    expect(run.departures[0]).toBeGreaterThanOrEqual(at)
    expect(run.departures[1]).toBeGreaterThan(run.departures[0])
  }))
)

test("an early bus waits at a timepoint for its scheduled time, as its course does, getting there before it leaves", () => {
  // Leaving stop 0 at 10:00, a few minutes' drive from a timepoint it's scheduled to leave at 10:10
  const feed = lineFeed([{ times: [36000, 36600, 37200], timepoints: [1] }])
  const run = runOn(buildRuns(feed, TODAY, NO_FORECAST, emptyModel(), [seen("0", BASE + 36000, false)]), "T0")
  expect(run.holdChance[1]).toBeCloseTo(0.8)
  expect(run.arrivals[1]).toBeLessThan(BASE + 36300)
  expect(run.departures[1]).toBe(BASE + 36600)
  expect(run.tracked!.trajectory.course.departures[1]).toBe(run.departures[1])
})

test("the stop list, the planner, and the drawn bus agree on when a followed bus gets to and leaves each stop ahead", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.integer({ min: -600, max: 900 }), fc.boolean(), (position, isThere, late, isTimed) => {
    const data = lineFeed([{ times: hours(10, 10.1, 10.2, 10.3, 10.4, 10.5), timepoints: isTimed ? [0, 2, 4] : [] }])
    const feed = withIndexes({ ...data, trips: data.trips.map(trip => ({ ...trip, shape: "S" })), shapes: { S: data.stops.map(({ lon, lat }) => [lon, lat]) } })
    const at = BASE + 36000 + position * 360 + late
    const runs = buildRuns(feed, TODAY, NO_FORECAST, learned(150, 30), [seen(`${position}`, at, isThere)])
    const run = runOn(runs, "T0")
    const { course, line, from } = run.tracked!.trajectory
    const positions = positionsOf(feed, run.trip)!
    expect(line).toBe(lineOf(feed, run.trip))
    const connections = buildConnections(runs, at).filter(connection => runs[connection.run] === run)
    for (let p = position + 1; p < run.trip.stops.length; p++) {
      // Drawn at the stop from when the run gets there to when it leaves
      for (const time of [run.arrivals[p], (run.arrivals[p] + run.departures[p]) / 2, run.departures[p]])
        expect(from + course.distanceAt(time)).toBeCloseTo(positions[p], 3)
      // Ridden from there when it leaves, and off there when it gets there
      const leaving = connections.find(connection => connection.position === p)
      if (leaving)
        expect(leaving.departure).toBe(run.departures[p])
      expect(connections.find(connection => connection.position === p - 1)?.arrival ?? run.arrivals[p]).toBe(run.arrivals[p])
    }
  }))
)

test("a bus running late goes on into the loop it's late for, the next of its block or the next due by the timetable, not the one due nearest by the clock", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 1500 }), fc.boolean(), (late, hasBlocks) => {
    // Loops every 20 minutes from 10:00, each 15 minutes long, alternating between two blocks
    const feed = lineFeed(Array.from({ length: 8 }, (_, i) => ({ times: [0, 300, 600, 900].map(s => 36000 + i * 1200 + s), ...hasBlocks && { block: `B${i % 2}` } })), true)
    // On T2's second stop, that much late
    const runs = buildRuns(feed, TODAY, NO_FORECAST, learned(300, 0), [seen("1", BASE + 36000 + 2 * 1200 + 300 + late, false, { tripId: "T2" })])
    const own = runs.filter(run => run.vehicle === "V").sort((a, b) => a.trip.times[0] - b.trip.times[0])
    expect(own[0].trip.id).toBe("T2")
    // Its block's next loop is T4; without blocks, T3 is the one due to start as T2 is due to end
    expect(own[1].trip.id).toBe(hasBlocks ? "T4" : "T3")
    // However late, each loop after starts a layover after the one before gets in
    own.slice(1).forEach((next, i) => expect(next.departures[0]).toBeGreaterThanOrEqual(own[i].arrivals[3]))
  }))
)

test("a bus of a timetabled route tagged with a trip it's far ahead of is chained on to the end and then around to the stops before it, and a headway route's is just early", () =>
  fc.assert(fc.property(fc.integer({ min: 1000, max: 3000 }), fc.boolean(), (early, isTimed) => {
    // A loop whose trip starts at 10:00 and takes 25 minutes, with timepoints if timetabled
    const feed = lineFeed([{ times: [0, 300, 600, 900, 1200, 1500].map(s => 36000 + s), timepoints: isTimed ? [0, 3] : [] }], true)
    // Seen leaving the fourth stop that much before the trip's time there, tagged with it
    const at = BASE + 36000 + 900 - early
    const run = runOn(buildRuns(feed, TODAY, NO_FORECAST, learned(300, 0), [seen("3", at, false)]), "T0")
    expect(run.tracked).toBeDefined()
    // The stops ahead are minutes away either way
    expect(run.departures[4] - at).toBeLessThan(600)
    if (isTimed)
      // It's on its way round to where the trip starts: the stops before it come after the end, in order
      for (let i = 0; i < 3; i++) {
        expect(run.departures[i]).toBeGreaterThan(run.departures[5])
        if (i < 2)
          expect(run.departures[i + 1]).toBeGreaterThanOrEqual(run.departures[i])
      }
    else
      // A headway route's timetable says nothing of where its bus is, so it had been at the stops before
      expect(run.departures[2]).toBeLessThanOrEqual(at)
  }))
)
