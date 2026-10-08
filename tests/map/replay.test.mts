import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { withIndexes, type FeedData } from "../../src/map/feed.mts"
import { extract, type Visit } from "../../src/map/events.mts"
import { unpackFixes, unpackPredictions, type RawFix, type RawPrediction } from "../../src/map/raw.mts"
import { LEADS, emptyModel, update } from "../../src/map/model.mts"
import { attachPredictions, score } from "../../scripts/map/replay.mts"

// Half an hour of the Worker's samples, recorded on a Wednesday afternoon with seven buses out, and the timetable
// then, cut down to their routes
const { feed: data, rows }: { feed: FeedData, rows: { source: string, at: number, body: unknown[] }[] } =
  JSON.parse(gunzipSync(readFileSync(new URL("fixtures/buses.json.gz", import.meta.url))).toString())
const feed = withIndexes(data)
const fixes = rows.filter(row => row.source === "buses").flatMap(row => unpackFixes(row.at, row.body as RawFix[]))
const samples = rows
  .filter(row => row.source === "predictions")
  .map(row => ({ at: row.at, predictions: unpackPredictions(row.at, row.body as RawPrediction[]) }))
const visits = attachPredictions(extract(feed, fixes), samples)
const DAY = "2026-10-07"

test("real fixes show every bus going through its trip's stops in order, at plausible paces", () => {
  const buses = Map.groupBy(visits, visit => visit.vehicle)
  expect(buses.size).toBeGreaterThanOrEqual(5)
  // About a stop a minute for each bus
  expect(visits.length).toBeGreaterThan(100)
  for (const own of buses.values())
    own.slice(1).forEach((visit, i) => {
      expect(visit.arrive).toBeGreaterThanOrEqual(own[i].depart)
      if (visit.trip === own[i].trip && visit.trip !== undefined)
        expect(visit.position).toBeGreaterThan(own[i].position!)
    })
  // Umo tags every bus with its trip, so nearly every visit has one, and most were driven to from the stop before
  expect(visits.filter(visit => visit.scheduled !== undefined).length / visits.length).toBeGreaterThan(0.95)
  const drives = visits.filter((visit): visit is Visit & { left: number, meters: number } => visit.left !== undefined)
  expect(drives.length / visits.length).toBeGreaterThan(0.7)
  for (const { arrive, left, meters } of drives)
    expect(meters / (arrive - left)).toBeLessThan(30)
  // A connector's bus gets in at the end of a loop and lays over before the next
  expect(visits.filter(visit => visit.gotIn !== undefined && visit.position === 0).length).toBeGreaterThanOrEqual(3)
  // Umo was sampled predicting most of them
  expect(visits.filter(visit => visit.umo).length / visits.length).toBeGreaterThan(0.5)
})

// How far off the model's forecasts were on the recording, in seconds at each lead, which changes to extraction or
// the model should only bring down, or explain
const MAE = [100, 145, 180, 260, 405]

test("forecasts from the model do no worse on the recording than they did", () => {
  const scored = score(emptyModel(), feed, visits)
  LEADS.slice(0, MAE.length).forEach((_, i) => {
    const [n, error] = scored.model[i]
    expect(n).toBeGreaterThan(0)
    expect(error / n).toBeLessThanOrEqual(MAE[i])
  })
  // And having learned from it, better still
  const learned = score(update(emptyModel(), DAY, visits, scored), feed, visits)
  expect(learned.model[0][1]).toBeLessThan(scored.model[0][1])
})
