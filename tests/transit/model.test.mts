import { test, expect } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { withIndexes, type Trip } from "../../src/transit/feed.mts"
import type { Visit } from "../../src/transit/inference/events.mts"
import { INCOMPLETE } from "../../src/transit/inference/events.mts"
import { LEADS, Model, asModel, contextAt, emptyModel, emptyScores, leadIndex, scored } from "../../src/transit/models/model.mts"
import { fold as foldIn, summarize, update } from "../../src/transit/models/fit.mts"
import {
  bandScale, holdChances, holdProbability, isLikely, legMu, lingerEstimate, offsetEstimate, profileEstimate, waitEstimate, zoneEstimate
} from "../../src/transit/models/estimates.mts"
import { addDays } from "../../src/shared/time.mts"
import { probit } from "../../src/shared/normal.mts"

const DAY = "2026-10-05"
// Midday on it, a Monday
const NOON = Date.UTC(2026, 9, 5, 16) / 1000

/** A bus's drive from stop a to b, taking some seconds, leaving at some epoch second */
const drive = (seconds: number, left = NOON, route = "R", vehicle = "V"): Visit => ({
  vehicle, route, stop: "b", arrive: left + seconds, depart: left + seconds + 10, from: "a", meters: 500, left
})

/** A visit to a stop on a known trip, arriving and leaving some seconds after its scheduled time */
const visit = (stop: string, early: number, late: number, extra: Partial<Visit> = {}): Visit => ({
  vehicle: "V", route: "R", stop, arrive: NOON + early, depart: NOON + late, trip: "T", position: 1, isEnd: false, scheduled: NOON, ...extra
})

const lognormal = (mu: number, sigma: number) =>
  fc.double({ min: -3, max: 3, noNaN: true }).map(z => Math.exp(mu + sigma * z))

/** Days of drives folded in one after another, each by its own bus */
const fold = (days: number[][]) =>
  days.reduce((model, seconds, i) => update(model, addDays(DAY, i), seconds.map((s, j) => drive(s, NOON + 600 * j, "R", `V${j}`))), emptyModel())

test("an empty model has nothing to say, so everything falls back on its own constants", () => {
  const model = emptyModel()
  expect(legMu(model, "R", "a", "b", 500, NOON)).toBeUndefined()
  expect(zoneEstimate(model, "R", "a", false)).toBeUndefined()
  expect(lingerEstimate(model, "R", "a", true, 0)).toBeUndefined()
  expect(offsetEstimate(model, "R", 0)).toBeUndefined()
  expect(waitEstimate(model, "R", NOON)).toBeUndefined()
  fc.assert(fc.property(fc.uniqueArray(fc.nat(9), { maxLength: 10 }), timepoints => {
    const trip: Trip = { id: "T", route: "R", service: "", headsign: "", shape: "", stops: Array(10).fill(0), times: Array(10).fill(0), timepoints }
    const feed = withIndexes({ version: "", start: "", end: "", routes: [], stops: [{ id: "a", name: "", lat: 0, lon: 0 }], services: {}, trips: [trip], shapes: {} })
    expect(holdChances(model, feed, trip).map(isLikely)).toEqual(trip.stops.map((_, i) => timepoints.includes(i)))
  }))
})

test("folding in a leg's drives recovers their mean log time", () =>
  fc.assert(fc.property(fc.double({ min: 2, max: 6, noNaN: true }), fc.array(lognormal(0, 0.3), { minLength: 1, maxLength: 50 }), (mu, noise) => {
    const seconds = noise.map(x => Math.exp(mu) * x)
    const mean = seconds.reduce((sum, s) => sum + Math.log(s), 0) / seconds.length
    // All at one time of day, so its context is the leg's own
    const model = update(emptyModel(), DAY, seconds.map((s, i) => drive(s, NOON, "R", `V${i}`)))
    // Stored to four places, as the build writes it
    expect(legMu(model, "R", "a", "b", 500, NOON + 60)).toBeCloseTo(mean, 3)
  }))
)

test("a leg nobody's driven takes as long as legs that long do", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 3, maxLength: 20 }), fc.double({ min: 1, max: 20, noNaN: true }), (lengths, rate) => {
    fc.pre(Math.max(...lengths) >= 2 * Math.min(...lengths))
    // Legs on other stretches, all driven at one rate
    const model = update(emptyModel(), DAY, lengths.map((meters, i): Visit => ({
      vehicle: `V${i}`, route: "R", stop: `${i}`, arrive: NOON + meters / rate, depart: NOON + meters / rate + 10, from: "x", meters, left: NOON
    })))
    expect(legMu(model, "R", "a", "b", 700, NOON)).toBeCloseTo(Math.log(700 / rate), 2)
  }))
)

test("a bus lost between two stops it visited one after the other still teaches the leg between them, unless it was gone too long to have been driving", () => {
  const before: Visit = { vehicle: "V", route: "R", stop: "a", arrive: NOON - 30, depart: NOON }
  const after = (gap: number): Visit => ({ vehicle: "V", route: "R", stop: "b", arrive: NOON + gap, depart: NOON + gap + 10 })
  expect(legMu(update(emptyModel(), DAY, [before, after(400)]), "R", "a", "b", 500, NOON)).toBeCloseTo(Math.log(400), 3)
  expect(legMu(update(emptyModel(), DAY, [before, after(4000)]), "R", "a", "b", 500, NOON)).toBeUndefined()
  // Another bus's visit is no leg of this one's
  expect(legMu(update(emptyModel(), DAY, [before, { ...after(400), vehicle: "W" }]), "R", "a", "b", 500, NOON)).toBeUndefined()
})

test("legs slower at some time of day are expected slower then, even on a leg seen only at other times", () => {
  // Two legs at noon and at 6 PM, the second always taking twice as long in the evening; and a third seen only at noon
  const at = (hour: number) => NOON + (hour - 12) * 3600
  const visits = [0, 1].flatMap(leg => [12, 18].flatMap(hour => Array.from({ length: 20 }, (_, i): Visit => ({
    vehicle: `V${leg}${hour}${i}`, route: "R", stop: `${leg}b`, arrive: at(hour) + (hour === 18 ? 200 : 100), depart: at(hour) + 300,
    from: `${leg}a`, meters: 500, left: at(hour)
  }))))
  const lone: Visit = { vehicle: "L", route: "R", stop: "cb", arrive: at(12) + 100, depart: at(12) + 110, from: "ca", meters: 500, left: at(12) }
  const model = update(emptyModel(), DAY, [...visits, lone])
  expect(contextAt(at(12))).not.toBe(contextAt(at(18)))
  // Nearly all the evening's doubling, less a little for what the lone leg's own noon says of it
  const slower = legMu(model, "R", "ca", "cb", 500, at(18))! - legMu(model, "R", "ca", "cb", 500, at(12))!
  expect(slower).toBeGreaterThan(0.8 * Math.log(2))
  expect(slower).toBeLessThanOrEqual(Math.log(2) + 1e-3)
})

test("time at stops is learned by route and stop, laying over by route at the start of a trip, and how much longer a bus already there stays", () => {
  const model = update(emptyModel(), DAY, [
    ...Array.from({ length: 10 }, (_, i) => visit("s", 0, 30, { vehicle: `V${i}` })),
    ...Array.from({ length: 10 }, (_, i) => visit("t", 0, 300, { vehicle: `W${i}`, position: 0 }))
  ])
  expect(zoneEstimate(model, "R", "s", false)?.mean).toBeCloseTo(30, 6)
  expect(zoneEstimate(model, "R", "t", true)?.mean).toBeCloseTo(300, 6)
  // A stop the route's never stopped at takes as long as any
  expect(zoneEstimate(model, "R", "elsewhere", false)?.mean).toBeCloseTo(30, 6)
  expect(lingerEstimate(model, "R", "t", true, 100)).toBeCloseTo(300 - 80, 6)
  expect(lingerEstimate(model, "R", "s", false, 0)).toBeCloseTo(30, 6)
})

test("a stop where early buses always wait comes to be one where they hold, and one where they never do, not, whatever the timetable says", () =>
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.integer({ min: 20, max: 60 }), (waits, isTimepoint, days) => {
    let model = emptyModel()
    for (let day = 0; day < days; day++)
      model = update(model, addDays(DAY, day), [visit("s", -300, waits ? 0 : -240)])
    // Decayed, the days long past count for less, so it takes a while either way
    const probability = holdProbability(model, "R", "s", isTimepoint)
    expect(waits ? probability > 0.8 : probability < 0.2).toBe(true)
  }))
)

test("how late a route runs is its mean lateness, leaving out buses so far off they're on another trip", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: -600, max: 600 }), { minLength: 1, maxLength: 30 }), lateness => {
    const model = update(emptyModel(), DAY, [
      ...lateness.map((late, i) => visit("s", late, late, { vehicle: `V${i}` })),
      visit("s", 2000, 2000, { vehicle: "stale" })
    ])
    expect(offsetEstimate(model, "R", 0)!.mean).toBeCloseTo(lateness.reduce((sum, x) => sum + x, 0) / lateness.length, 6)
  }))
)

/** Buses leaving each of some stops every so often through the hour after noon, each a different bus from the last */
const headways = (headway: number) =>
  update(emptyModel(), DAY, Array.from({ length: 30 }, (_, stop) =>
    Array.from({ length: Math.floor(3590 / headway) + 1 }, (_, i): Visit =>
      ({ vehicle: `V${i % 2}`, route: "R", stop: `${stop}`, arrive: NOON + i * headway, depart: NOON + 5 + i * headway })
    )
  ).flat())

test("a route's buses coming every so often are next due within less than that", () =>
  fc.assert(fc.property(fc.integer({ min: 120, max: 1795 }), headway => {
    const estimate = waitEstimate(headways(headway), "R", NOON + 1800)!
    expect(estimate.headway).toBeCloseTo(headway, 2)
    expect(estimate.wait).toBeGreaterThan(0)
    expect(estimate.wait).toBeLessThanOrEqual(headway)
  }))
)

test("buses evenly spaced are next due half a headway away, as likely as not", () =>
  expect(waitEstimate(headways(300), "R", NOON + 1800)!.wait).toBeCloseTo(150, -1)
)

test("no bus seen while the Worker wasn't listening isn't a gap between buses", () => {
  const visits = [0, 600, 1200].map((offset, i): Visit => ({ vehicle: `V${i}`, route: "R", stop: "0", arrive: NOON + offset, depart: NOON + offset + 5 }))
  // Deaf from 5 to 15 minutes past noon, so a bus may have come between the first two
  const isListening = (from: number, to: number) => to <= (NOON + 300) * 1000 || from >= (NOON + 900) * 1000
  expect(summarize(visits).headways.R.flatMap(cell => cell ?? [])).toEqual([2, 1200, 720_000])
  expect(summarize(visits, emptyScores(), isListening).headways.R).toBeUndefined()
  const heard = (from: number, to: number) => to <= (NOON + 300) * 1000 || from >= (NOON + 500) * 1000
  expect(summarize(visits, emptyScores(), heard).headways.R.flatMap(cell => cell ?? [])).toEqual([1, 600, 360_000])
})

test("each lead is scored at its own, and the band is as wide as the forecasts turned out to be, or a normal one's before there are enough", () => {
  LEADS.forEach((minutes, i) => expect(leadIndex(minutes * 60)).toBe(i))
  expect(bandScale(emptyModel(), 300, 0.8)).toBeCloseTo(probit(0.9), 6)
  fc.assert(fc.property(fc.integer({ min: -4, max: 0 }), fc.integer({ min: 2, max: 5 }), fc.double({ min: 0.1, max: 0.9, noNaN: true }), (low, octaves, p) => {
    // Forecasts off by evenly spread multiples of their spread, on a log scale
    const ratios = Array.from({ length: 400 }, (_, i) => 2 ** (low + octaves * i / 399))
    const scores = emptyScores()
    for (const ratio of ratios)
      scored(scores, "model", 300, ratio * 20, 20)
    const model = update(emptyModel(), DAY, [], scores)
    const inside = ratios.filter(ratio => ratio <= bandScale(model, 300, p)).length / ratios.length
    // Within a bin's share of the share asked for
    expect(Math.abs(inside - p)).toBeLessThanOrEqual(0.25 / octaves + 0.01)
  }))
})

test("a model the build folds, as it's stored, always fits the schema the page loads it by, and one of another shape doesn't", () =>
  fc.assert(fc.property(fc.array(fc.array(lognormal(4, 0.3), { maxLength: 10 }), { minLength: 1, maxLength: 10 }), days => {
    const stored = JSON.parse(JSON.stringify(fold(days)))
    expect(v.is(Model, stored)).toBe(true)
    expect(asModel(stored)).toBe(stored)
    expect(asModel({ ...stored, version: 2 })).toEqual(emptyModel())
  }))
)

test("the model's size is bounded by the stops and routes it's seen, not by how long it's been learning", () =>
  fc.assert(fc.property(fc.array(fc.array(lognormal(4, 0.3), { maxLength: 10 }), { minLength: 1, maxLength: 30 }), days => {
    const model = fold(days)
    expect(Object.keys(model.legs).length).toBeLessThanOrEqual(1)
    expect(model.legs["R:a>b"]?.length ?? 24).toBe(24)
  }))
)

test("the model is its days' summaries folded together, so folding them again is the same as learning the days again", () =>
  fc.assert(fc.property(fc.array(fc.array(lognormal(4, 0.3), { maxLength: 10 }), { minLength: 1, maxLength: 10 }), fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 10, maxLength: 10 }), (days, steps) => {
    let day = DAY
    const dated = days.map((seconds, i) => {
      day = addDays(day, steps[i])
      return { day, visits: seconds.map((s, j) => drive(s, NOON + 600 * j, "R", `V${j}`)) }
    })
    const learned = dated.reduce((model, { day, visits }) => update(model, day, visits), emptyModel())
    const summaries = dated.map(({ day, visits }) => ({ day, summary: JSON.parse(JSON.stringify(summarize(visits))) }))
    expect(summaries.reduce((model, { day, summary }) => foldIn(model, day, summary), emptyModel())).toEqual(learned)
  }))
)

test("how buses spend their time along a leg is its own, leaning on every leg's while it's seen few", () => {
  const along = (stop: string, profile: number[]): Visit =>
    ({ vehicle: `V${stop}`, route: "R", stop, arrive: NOON + 100, depart: NOON + 110, from: "a", meters: 500, left: NOON, profile })
  const model = update(emptyModel(), DAY, [
    ...Array.from({ length: 50 }, () => along("b", [0.1, 0.2, 0.3])),
    along("c", [0.5, 0.8, 0.9])
  ].map((visit, i) => ({ ...visit, vehicle: `V${i}` })))
  const busy = profileEstimate(model, "R", "a", "b")
  const lone = profileEstimate(model, "R", "a", "c")
  busy.forEach((share, j) => expect(share).toBeCloseTo([0.1, 0.2, 0.3][j], 1))
  // Mostly every leg's, as it's been seen once
  lone.forEach((share, j) => expect(share).toBeLessThan([0.5, 0.8, 0.9][j]))
  expect(profileEstimate(emptyModel(), "R", "a", "b")).toHaveLength(3)
})

test("a bus last seen still at a stop says nothing of how long buses stay there", () => {
  const stays = [visit("s", 0, 30, { vehicle: "A" }), visit("s", 0, 30, { vehicle: "B" })]
  const cut = visit("s", 0, 5, { vehicle: "C", flags: INCOMPLETE })
  expect(zoneEstimate(update(emptyModel(), DAY, [...stays, cut]), "R", "s", false)?.mean).toBeCloseTo(30, 6)
})
