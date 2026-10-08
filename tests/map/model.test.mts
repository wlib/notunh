import { test, expect } from "vitest"
import fc from "fast-check"
import { withIndexes, type Trip } from "../../src/map/feed.mts"
import type { Visit } from "../../src/map/events.mts"
import {
  LEADS, contextAt, driveEstimate, dwellEstimate, emptyModel, heldPositions, holdProbability, layoverEstimate,
  leadIndex, quantile, shrink, update, deviationEstimate, type Cell
} from "../../src/map/model.mts"
import { addDays } from "../../src/shared/time.mts"

const DAY = "2026-10-05"
// Midday on it, a Monday
const NOON = Date.UTC(2026, 9, 5, 16) / 1000

/** A bus's drive from stop a to b, taking some seconds, leaving at some epoch second */
const drive = (seconds: number, left = NOON, route = "R"): Visit => ({
  vehicle: "V", route, stop: "b", arrive: left + seconds, depart: left + seconds + 10, from: "a", meters: 500, left
})

/** A visit to a stop on a known trip, arriving and leaving some seconds after its scheduled time */
const visit = (stop: string, early: number, late: number, extra: Partial<Visit> = {}): Visit => ({
  vehicle: "V", route: "R", stop, arrive: NOON + early, depart: NOON + late, trip: "T", position: 1, isEnd: false, scheduled: NOON, ...extra
})

const lognormal = (mu: number, sigma: number) =>
  fc.array(fc.double({ min: -3, max: 3, noNaN: true }), { minLength: 1, maxLength: 1 }).map(([z]) => Math.exp(mu + sigma * z))

/** Days of drives folded in one after another */
const fold = (days: number[][]) =>
  days.reduce((model, seconds, i) => update(model, addDays(DAY, i), seconds.map(s => drive(s))), emptyModel())

test("an empty model has nothing to say, so everything falls back on its own constants", () => {
  const model = emptyModel()
  expect(driveEstimate(model, "R", "a>b", 500, 0)).toBeUndefined()
  expect(dwellEstimate(model, "a", 0)).toBeUndefined()
  expect(layoverEstimate(model, "R")).toBeUndefined()
  expect(deviationEstimate(model, "R", "a", 0)).toBeUndefined()
  fc.assert(fc.property(fc.uniqueArray(fc.nat(9), { maxLength: 10 }), timepoints => {
    const trip: Trip = { id: "T", route: "R", service: "", headsign: "", shape: "", stops: Array(10).fill(0), times: Array(10).fill(0), timepoints }
    const feed = withIndexes({ version: "", start: "", end: "", routes: [], stops: [{ id: "a", name: "", lat: 0, lon: 0 }], services: {}, trips: [trip], shapes: {} })
    expect(heldPositions(model, feed, trip)).toEqual(trip.stops.map((_, i) => timepoints.includes(i)))
  }))
})

test("folding in drives recovers their median and spread", () =>
  fc.assert(fc.property(fc.double({ min: 2, max: 6, noNaN: true }), fc.double({ min: 0.15, max: 0.6, noNaN: true }), (mu, sigma) => {
    // Evenly spread quantiles of the lognormal, plenty of them to outweigh a typical spread
    const seconds = Array.from({ length: 399 }, (_, i) => quantile({ mu, sigma, n: 0 }, (i + 1) / 400))
    const estimate = driveEstimate(update(emptyModel(), DAY, seconds.map(s => drive(s))), "R", "a>b", 500, contextAt(NOON))!
    expect(estimate.mu).toBeCloseTo(mu, 2)
    expect(estimate.sigma / sigma).toBeGreaterThan(0.9)
    expect(estimate.sigma / sigma).toBeLessThan(1.1)
  }))
)

test("shrinkage moves from the broader estimate to the cell's own as the cell gets more data", () =>
  fc.assert(fc.property(
    fc.double({ min: -5, max: 5, noNaN: true }),
    fc.double({ min: -5, max: 5, noNaN: true }),
    fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 2, maxLength: 6 }),
    (own, parent, counts) => {
      const sorted = counts.sort((a, b) => a - b)
      const mus = sorted.map(n => shrink([n, n * own, n * own * own] satisfies Cell, { mu: parent, sigma: 1, n: 0 }, 8).mu)
      const toward = mus.map(mu => Math.abs(mu - own))
      toward.slice(1).forEach((distance, i) => expect(distance).toBeLessThanOrEqual(toward[i] + 1e-9))
      mus.forEach(mu => expect(Math.min(own, parent) - 1e-9 <= mu && mu <= Math.max(own, parent) + 1e-9).toBe(true))
    }
  ))
)

test("quantiles grow with probability", () =>
  fc.assert(fc.property(fc.double({ min: 0.001, max: 0.999, noNaN: true }), fc.double({ min: 0.001, max: 0.999, noNaN: true }), (p, q) => {
    const estimate = { mu: 4, sigma: 0.3, n: 1 }
    expect(quantile(estimate, Math.min(p, q))).toBeLessThanOrEqual(quantile(estimate, Math.max(p, q)))
  }))
)

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

test("only stops a bus couldn't have been waiting at teach how long it spends at them, and not either end of a trip", () => {
  const model = update(emptyModel(), DAY, [
    visit("waited", -300, 0),
    visit("late", 60, 90),
    visit("left early", -300, -200),
    visit("end", 60, 90, { isEnd: true })
  ])
  expect(Object.keys(model.dwells).sort()).toEqual(["late", "left early"])
  expect(Math.exp(dwellEstimate(model, "late", 0)!.mu)).toBeCloseTo(30, 1)
})

test("layovers are learned by route, and each lead is scored at its own", () => {
  const model = update(emptyModel(), DAY, [visit("s", 0, 0, { gotIn: NOON - 300 })])
  expect(Math.exp(layoverEstimate(model, "R")!.mu)).toBeCloseTo(300, 1)
  LEADS.forEach((minutes, i) => expect(leadIndex(minutes * 60)).toBe(i))
})

test("the model's size is bounded by the stops and routes it's seen, not by how long it's been learning", () =>
  fc.assert(fc.property(fc.array(fc.array(lognormal(4, 0.3), { maxLength: 10 }), { minLength: 1, maxLength: 30 }), days => {
    const model = fold(days)
    expect(Object.keys(model.drives).length).toBeLessThanOrEqual(1)
    expect(model.drives["a>b"]?.length ?? 10).toBe(10)
  }))
)
