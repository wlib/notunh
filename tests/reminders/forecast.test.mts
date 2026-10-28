import { test, expect } from "vitest"
import { withIndexes } from "../../src/transit/feed.mts"
import { NO_FORECAST, forecastFrom, forecastOfSample } from "../../src/transit/observations/predictions.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { runOf, runsAt, scheduledOnly, scheduledRuns, seenOf } from "../../src/reminders/forecast.mts"
import { type Watch, GONE } from "../../src/reminders/watch.mts"
import { recordedData as data, recordedFeed as feed, recordedFixes as fixes, recordedPredictions as sampled } from "../map/fixtures/recording.mts"

// The recording's route 3 bus on its way to Thompson Hall, due there at 18:31 UTC and leaving at 18:40
const RUN = { stop: "209", route: "3", trip: "3B FULL_T04" }
const WATCH: Watch = { at: 1791397860, lead: 600, run: RUN }
const LEFT = 1791398421
const model = emptyModel()

/** What's foretold at an epoch second from the fixes got by then and the latest predictions, as the Worker's check does */
const seenAt = (now: number, watch = WATCH, timetable = feed) => {
  const latest = sampled.filter(({ at }) => at <= now * 1000).at(-1)
  const forecast = latest ? forecastOfSample(latest) : NO_FORECAST
  return seenOf(timetable, runsAt(timetable, model, fixes, forecast, now), () => scheduledRuns(timetable, model, now), watch, now)
}

test("a watched run is foretold from its bus as followed, live and within minutes of when it left, then passed once it has", () => {
  for (const ahead of [1200, 900, 600, 300]) {
    const seen = seenAt(LEFT - ahead)
    expect(seen).toMatchObject({ status: "coming", isLive: true })
    expect(Math.abs(seen.time - LEFT)).toBeLessThan(600)
    expect(seen.band).toBeGreaterThanOrEqual(30)
  }
  expect(seenAt(LEFT + GONE + 60).status).toBe("passed")
})

test("the run is found by its trip at its scheduled time, or by the route's run due at the stop then under a timetable that renamed it", () => {
  const runs = scheduledRuns(feed, model, LEFT - 900)
  expect(runOf(feed, runs, WATCH)).toMatchObject({ run: { trip: { id: RUN.trip } }, position: 25 })
  expect(runOf(feed, runs, { ...WATCH, run: { ...RUN, trip: "renamed" } })).toMatchObject({ run: { trip: { id: RUN.trip } }, position: 25 })
  expect(runOf(feed, runs, { ...WATCH, at: WATCH.at + 3600, run: { ...RUN, trip: "renamed" } })).toBeUndefined()
  expect(runOf(feed, runs, { at: WATCH.at, lead: 600 })).toBeUndefined()
})

test("a run the source has dropped is cancelled, and one the timetable no longer has is lost, not cancelled", () => {
  const now = LEFT - 900
  // The source's word covers the stop past the run's time there without naming it, so the run was missed
  const dropped = seenOf(feed, runsAt(feed, model, [], forecastFrom([{ route: "3", stop: "209", vehicle: "T-1", trip: "3B FULL_T01", time: WATCH.at + 3600, isLive: true }], now), now), () => scheduledRuns(feed, model, now), WATCH, now)
  expect(dropped).toMatchObject({ status: "cancelled", isLive: false })
  // A watch set under a timetable that had the run, swapped for one that doesn't
  const without = withIndexes({ ...data, trips: data.trips.filter(trip => trip.id !== RUN.trip) })
  expect(seenAt(now, WATCH, without)).toMatchObject({ status: "lost", isLive: false, time: WATCH.at })
  expect(seenAt(now, { ...WATCH, at: WATCH.at + 86400 * 3 })).toMatchObject({ status: "lost" })
})

test("a run on another route that a followed bus goes on to is foretold from that bus, as the map does, rather than from the timetable", () => {
  // Route 3's bus ends at the terminal, where a route 4 run starts minutes later, as a block would
  const bus = data.trips.find(trip => trip.id === RUN.trip)!
  const reverse = data.trips.find(trip => trip.route === "4")!
  const stops = [...reverse.stops].reverse()
  const start = bus.times.at(-1)! + 300
  const next = { id: "4X", route: "4", service: bus.service, headsign: "Back", shape: "back", stops, times: stops.map((_, i) => start + 90 * i), timepoints: [] }
  const joined = withIndexes({ ...data, trips: [...data.trips, next], shapes: { ...data.shapes, back: [...data.shapes[reverse.shape]].reverse() } })
  const now = LEFT - 600
  const position = 6
  const watch: Watch = { at: 1791397860 - bus.times[25] + next.times[position], lead: 600, run: { stop: feed.stops[stops[position]].id, route: "4", trip: "4X" } }
  const run = runsAt(joined, model, fixes, NO_FORECAST, now).find(run => run.trip.id === "4X" && run.vehicle)!
  expect(run).toMatchObject({ vehicle: "T-54", isLive: false })
  expect(run.tracked).toBeDefined()
  const seen = seenAt(now, watch, joined)
  expect(seen).toMatchObject({ status: "coming", time: run.departures[position] })
  expect(seen.time).not.toBe(watch.at)
})

test("with no forecast to be had, a run is due as scheduled, give or take, until it's gone by, and a watch on no run is its fixed time exactly, whatever's foretold", () => {
  expect(scheduledOnly(WATCH, WATCH.at - 600)).toMatchObject({ time: WATCH.at, isLive: false, status: "coming" })
  expect(scheduledOnly(WATCH, WATCH.at - 600).band).toBeGreaterThan(60)
  expect(scheduledOnly(WATCH, WATCH.at + GONE + 1).status).toBe("passed")
  const fixed: Watch = { at: LEFT - 300, lead: 300 }
  expect(scheduledOnly(fixed, LEFT - 900)).toEqual({ time: fixed.at, band: 0, isLive: false, status: "coming" })
  expect(seenAt(LEFT - 900, fixed)).toEqual({ time: fixed.at, band: 0, isLive: false, status: "coming" })
  expect(seenAt(fixed.at + GONE + 1, fixed).status).toBe("passed")
})
