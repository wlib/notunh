import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { withIndexes, type FeedData } from "../../src/transit/feed.mts"
import { extract, type Visit } from "../../src/transit/inference/events.mts"
import { unpackFixes, unpackPredictions, type RawFix, type RawPrediction } from "../../src/transit/observations/raw.mts"
import { LEADS, emptyModel } from "../../src/transit/models/model.mts"
import { update } from "../../src/transit/models/fit.mts"
import { PREDICTOR, attachPredictions, score } from "../../scripts/map/replay.mts"
import { sightingsFrom } from "../../src/transit/models/tracking.mts"

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
const visits = extract(feed, fixes)
const predicted = attachPredictions(visits, samples)
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
  expect(predicted.filter(visit => visit.umo).length / visits.length).toBeGreaterThan(0.5)
})

test("the buses are replayed as the map got their fixes, each once a poll got it, and an older fix got after a newer one passed over", () => {
  const LAG = 25_000
  // Every fix got LAG after it was taken, and some fixes got again much later, as Umo sometimes sends an old one
  const got = [...fixes.map(fix => ({ ...fix, received: fix.at + LAG })), ...fixes.filter((_, i) => i % 7 === 0).map(fix => ({ ...fix, received: fix.at + 10 * LAG }))]
  const [asGot, asTaken] = [sightingsFrom(feed, emptyModel(), got), sightingsFrom(feed, emptyModel(), fixes)]
  const start = Math.min(...fixes.map(fix => fix.at)) / 1000
  for (let at = start + 300; at < start + 1500; at += 60)
    expect(asGot(at + LAG / 1000)).toEqual(asTaken(at))
})

// How far off the chain's forecasts of followed buses were on the recording: mean absolute error in seconds at
// leads of 1, 3, 5, 10, and 20 minutes, each forecast at a 5-minute sample scored by the lead it was forecast at,
// as the map and the Worker ask for its band, and only where the chain foretells the stop (REPLAY 4; with the
// stops handed off to the timetable counted in, as REPLAY 3 had it, the 20-minute lead was 350 on 60 departures,
// and by how far off the departure turned out to be, as before that, 65, 110, 215, 250, and 415). Changes to
// extraction or the model should only bring these down, or explain why. The 5- to 20-minute leads rest on only 50
// to 90 departures in this half hour, so a few seconds either way can be noise. From 5 minutes on, the chain also
// covers the loops a bus goes on into, which with nothing learned yet lay over 10 s rather than the two minutes they
// do, and so come out a few minutes early, still half the timetable's error
const MAE = [65, 85, 130, 210, 355]

test("forecasts from the model do no worse on the recording than they did, and what the map shows is never worse than the timetable", () => {
  const observed = { fixes, predictions: samples }
  const scored = score(emptyModel(), feed, visits, observed)
  LEADS.slice(0, MAE.length).forEach((_, i) => {
    const [n, error] = scored.tracked[i]
    expect(n).toBeGreaterThan(0)
    expect(error / n).toBeLessThanOrEqual(MAE[i])
  })
  // Every departure is scored as the map would show it, which is the timetable where no bus is followed, short of
  // the few Umo's word as sampled then had as not coming, which the map shows nothing for, so at the leads the half
  // hour has followed buses at, it's never worse than the timetable
  LEADS.forEach((_, i) => {
    expect(scored.model[i][0]).toBeLessThanOrEqual(scored.schedule[i][0])
    expect(scored.model[i][0]).toBeGreaterThanOrEqual(0.98 * scored.schedule[i][0])
    if (scored.tracked[i][0] >= 20)
      expect(scored.model[i][1] / scored.model[i][0]).toBeLessThanOrEqual(scored.schedule[i][1] / scored.schedule[i][0])
  })
  // And having learned from it, better still
  const learned = score(update(emptyModel(), DAY, visits, { predictor: PREDICTOR, scores: scored }), feed, visits, observed)
  expect(learned.tracked[0][1]).toBeLessThan(scored.tracked[0][1])
})

test("a bus Umo predicts at a stop for two loops is matched to its next visit by the sooner prediction", () => {
  const [visit] = visits.filter(visit => visit.trip !== undefined)
  // The sample a 5-minute lead reads, on the 5-minute grid the Worker polls predictions on
  const at = Math.floor((visit.depart - 5 * 60) / 300) * 300 * 1000
  const prediction = (minutes: number) =>
    ({ route: visit.route, stop: visit.stop, vehicle: visit.vehicle, trip: null, at: visit.depart * 1000 + minutes * 60_000, isLayover: false })
  for (const order of [[0, 40], [40, 0]]) {
    const [matched] = attachPredictions([visit], [{ at, predictions: order.map(prediction) }])
    const times = matched.umo?.filter(time => time !== null) ?? []
    expect(times.length).toBeGreaterThan(0)
    expect(times.every(time => time === visit.depart)).toBe(true)
  }
})
