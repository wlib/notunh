import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { type FeedData, withIndexes } from "../../src/transit/feed.mts"
import { type RawFix, type RawPrediction, unpackFixes, unpackPredictions } from "../../src/transit/observations/raw.mts"
import { NO_FORECAST, forecastFrom } from "../../src/transit/observations/predictions.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { sightingsFrom } from "../../src/transit/models/tracking.mts"
import { routeFeed, runOf, scheduledOnly, seenOf } from "../../src/reminders/forecast.mts"
import { type Watch, GONE } from "../../src/reminders/watch.mts"
import { buildRuns } from "../../src/transit/models/forecast.mts"

// Half an hour of the Worker's samples on a Wednesday afternoon (tests/map/replay.test.mts), with a route 3 bus on
// its way to Thompson Hall (stop 209), due there at 18:31 UTC and leaving at 18:40
const { feed: data, rows }: { feed: FeedData, rows: { source: string, at: number, body: unknown[] }[] } =
  JSON.parse(gunzipSync(readFileSync(new URL("../map/fixtures/buses.json.gz", import.meta.url))).toString())
const feed = withIndexes(data)
const fixes = rows.filter(row => row.source === "buses").flatMap(row => unpackFixes(row.at, { version: 0, samples: row.body as RawFix[], polls: null }))
const sampled = rows.filter(row => row.source === "predictions").map(row => ({ at: row.at, predictions: unpackPredictions(row.at, { version: 0, samples: row.body as RawPrediction[], polls: null }) }))
const WATCH: Watch = { stop: "209", route: "3", trip: "3B FULL_T04", scheduled: 1791397860, lead: 600 }
const LEFT = 1791398421
const model = emptyModel()

/** What's foretold at an epoch second from the fixes got by then and the latest predictions, on the route's trips alone */
const seenAt = (now: number, watch = WATCH) => {
  const latest = sampled.filter(({ at }) => at <= now * 1000).at(-1)
  const forecast = latest ? forecastFrom(latest.predictions.map(({ at, isLayover, ...rest }) => ({ ...rest, time: at / 1000, isLive: !isLayover })), latest.at / 1000) : NO_FORECAST
  const route = routeFeed(feed, watch.route)
  return seenOf(route, model, watch, sightingsFrom(route, model, fixes.filter(fix => fix.route === watch.route))(now), forecast, now)
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

test("the run is found by its trip at its scheduled time, or by the route's run due at the stop then under a timetable that renamed it, and a run the day hasn't is cancelled", () => {
  const now = LEFT - 900
  const runs = buildRuns(routeFeed(feed, "3"), "2026-10-07", NO_FORECAST, model, [])
  expect(runOf(feed, runs, WATCH)).toMatchObject({ run: { trip: { id: WATCH.trip } }, position: 25 })
  expect(runOf(feed, runs, { ...WATCH, trip: "renamed" })).toMatchObject({ run: { trip: { id: WATCH.trip } }, position: 25 })
  expect(runOf(feed, runs, { ...WATCH, trip: "renamed", scheduled: WATCH.scheduled + 3600 })).toBeUndefined()
  expect(seenAt(now, { ...WATCH, scheduled: WATCH.scheduled + 86400 * 3 })).toMatchObject({ status: "cancelled", isLive: false })
})

test("with no forecast to be had, a run is due as scheduled, give or take, until it's gone by", () => {
  expect(scheduledOnly(WATCH, WATCH.scheduled - 600)).toMatchObject({ time: WATCH.scheduled, isLive: false, status: "coming" })
  expect(scheduledOnly(WATCH, WATCH.scheduled - 600).band).toBeGreaterThan(60)
  expect(scheduledOnly(WATCH, WATCH.scheduled + GONE + 1).status).toBe("passed")
})
