import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { withIndexes, type FeedData } from "../../src/transit/feed.mts"
import { extract, type Visit } from "../../src/transit/inference/events.mts"
import { unpackFixes, unpackPredictions, type RawFix, type RawPrediction } from "../../src/transit/observations/raw.mts"
import { LEADS, emptyModel } from "../../src/transit/models/model.mts"
import { update } from "../../src/transit/models/fit.mts"
import { attachPredictions, replayed, score } from "../../scripts/map/replay.mts"

// Half an hour of the Worker's samples, recorded on a Wednesday afternoon with seven buses out, and the timetable
// then, cut down to their routes
const { feed: data, rows }: { feed: FeedData, rows: { source: string, at: number, body: unknown[] }[] } =
  JSON.parse(gunzipSync(readFileSync(new URL("fixtures/buses.json.gz", import.meta.url))).toString())
const feed = withIndexes(data)
// Recorded before rows were versioned, as bare arrays of samples
const fixes = rows.filter(row => row.source === "buses").flatMap(row => unpackFixes(row.at, { version: 0, samples: row.body as RawFix[], polls: null }))
const samples = rows
  .filter(row => row.source === "predictions")
  .map(row => ({ at: row.at, predictions: unpackPredictions(row.at, { version: 0, samples: row.body as RawPrediction[], polls: null }) }))
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

test("the buses are replayed as the map got their fixes, each once a poll got it, and an older fix got after a newer one passed over", () => {
  const LAG = 25_000
  // Every fix got LAG after it was taken, and some fixes got again much later, as Umo sometimes sends an old one
  const got = [...fixes.map(fix => ({ ...fix, received: fix.at + LAG })), ...fixes.filter((_, i) => i % 7 === 0).map(fix => ({ ...fix, received: fix.at + 10 * LAG }))]
  const [asGot, asTaken] = [replayed(feed, emptyModel(), got), replayed(feed, emptyModel(), fixes)]
  const start = Math.min(...fixes.map(fix => fix.at)) / 1000
  for (let at = start + 300; at < start + 1500; at += 60)
    expect(asGot(at + LAG / 1000)).toEqual(asTaken(at))
})

// How far off the model's forecasts were on the recording: mean absolute error in seconds at leads of 1, 3, 5, 10,
// and 20 minutes. Changes to extraction or the model should only bring these down, or explain why. The 5- and
// 10-minute leads rest on only 50 to 110 departures in this half hour, so a few seconds either way can be noise
const MAE = [62, 116, 171, 192, 260]

test("forecasts from the model do no worse on the recording than they did", () => {
  const scored = score(emptyModel(), feed, visits, fixes)
  LEADS.slice(0, MAE.length).forEach((_, i) => {
    const [n, error] = scored.model[i]
    expect(n).toBeGreaterThan(0)
    expect(error / n).toBeLessThanOrEqual(MAE[i])
  })
  // And having learned from it, better still
  const learned = score(update(emptyModel(), DAY, visits, scored), feed, visits, fixes)
  expect(learned.model[0][1]).toBeLessThan(scored.model[0][1])
})

test("a bus Umo predicts at a stop for two loops is matched to its next visit by the sooner prediction", () => {
  const [visit] = visits.filter(visit => visit.trip !== undefined)
  // The sample a 5-minute lead reads, on the 5-minute grid the Worker polls predictions on
  const at = Math.floor((visit.depart - 5 * 60) / 300) * 300 * 1000
  const prediction = (minutes: number) =>
    ({ route: visit.route, stop: visit.stop, vehicle: visit.vehicle, trip: null, at: visit.depart * 1000 + minutes * 60_000, isLayover: false })
  for (const order of [[0, 40], [40, 0]]) {
    const [matched] = attachPredictions([{ ...visit, umo: undefined }], [{ at, predictions: order.map(prediction) }])
    const times = matched.umo?.filter(time => time !== null) ?? []
    expect(times.length).toBeGreaterThan(0)
    expect(times.every(time => time === visit.depart)).toBe(true)
  }
})
