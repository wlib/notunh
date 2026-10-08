import { test, expect } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { DEAD_AFTER, QUIET_RUNNING, STATUS_IDS, assess, assessRoom, statusOf, summarize, type History, type Machine } from "../../src/laundry/infer.mts"
import { normalize, parseMachines, type UpstreamMachine } from "../../src/laundry/upstream.mts"

const NOW = Date.parse("2026-10-07T16:33:02Z")
const DAY = 86_400_000
const STATES = ["free", "running", "done", "out"]

const snapshot = (time: string) =>
  parseMachines("loc_ffa038", JSON.parse(readFileSync(new URL(`fixtures/stoke-g05-${time}.json`, import.meta.url), "utf8")))

const machine: fc.Arbitrary<Machine> = fc
  .record({
    raw:       fc.oneof(fc.constantFrom(...STATUS_IDS), fc.string(), fc.constantFrom("constructor", "__proto__")),
    at:        fc.integer({ min: NOW - 3 * DAY, max: NOW + 3 * DAY }),
    remaining: fc.integer({ min: 0, max: 7200 }),
    kind:      fc.constantFrom("washer" as const, "dryer" as const)
  })
  .map(({ raw, at, remaining, kind }) => ({ id: "m", room: "r", number: "1", kind, model: "SWNNY2SP115TW01", status: statusOf(raw), raw, at, remaining }))

const history: fc.Arbitrary<History> = fc.record({
  changedAt:     fc.integer({ min: NOW - 6 * DAY, max: NOW }),
  roomChangedAt: fc.integer({ min: NOW - 6 * DAY, max: NOW })
})

const now = fc.integer({ min: NOW - DAY, max: NOW + DAY })

test("every status id, known or not, comes out as one of the four states, and unknown ones as out", () =>
  fc.assert(fc.property(machine, now, fc.option(history, { nil: undefined }), (m, t, h) => {
    expect(STATES).toContain(assess(m, t, h).state)
    if (!STATUS_IDS.includes(m.raw))
      expect(assess(m, t, h).state).toBe("out")
  }))
)

test("as a report ages, done never goes back to running, free stays free, and a running finish never moves earlier", () =>
  fc.assert(fc.property(machine, now, fc.integer({ min: 0, max: 2 * DAY }), (m, t1, later) => {
    const [a, b] = [assess(m, t1), assess(m, t1 + later)]
    if (a.state === "done")
      expect(b.state).not.toBe("running")
    if (a.state === "free" && a.basis === "reported")
      expect(b.state).toBe("free")
    if (a.state === "running" && b.state === "running")
      expect(b.readyAt!).toBeGreaterThanOrEqual(a.readyAt!)
  }))
)

test("a running machine is due no earlier than now, and a done one finished no later", () =>
  fc.assert(fc.property(machine, now, fc.option(history, { nil: undefined }), (m, t, h) => {
    const { state, readyAt } = assess(m, t, h)
    if (state === "running")
      expect(readyAt!).toBeGreaterThanOrEqual(t)
    if (state === "done")
      expect(readyAt!).toBeLessThanOrEqual(t)
  }))
)

test("a fresh countdown is reported as is, and anything inferred or stale says why", () =>
  fc.assert(fc.property(machine, now, (m, t) => {
    const assessment = assess(m, t)
    if (m.status === "running" && t - m.at < QUIET_RUNNING)
      expect(assessment).toMatchObject({ state: "running", basis: "reported" })
    if (assessment.basis !== "reported")
      expect(assessment.note).toBeTruthy()
  }))
)

test("a machine is only called dead when it's said nothing for days and its room has changed since, so neither a quiet room nor an idle machine that still reports is", () =>
  fc.assert(fc.property(machine, now, history, (m, t, h) => {
    const assessment = assess(m, t, h)
    if (assessment.note === "not reporting")
      expect(h.roomChangedAt > h.changedAt && t - h.changedAt > DEAD_AFTER && t - m.at > DEAD_AFTER).toBe(true)
    expect(assess(m, t, { changedAt: h.changedAt, roomChangedAt: h.changedAt })).toEqual(assess(m, t))
  }))
)

test("a room's counts add up, and say when the next one frees up exactly when none is free and one could", () =>
  fc.assert(fc.property(fc.array(machine, { maxLength: 16 }), now, (machines, t) => {
    const assessed = machines.map(m => assess(m, t))
    const summary = summarize(machines, assessed)
    for (const kind of ["washer", "dryer"] as const) {
      const counts = summary[kind]
      const ofKind = assessed.filter((_, i) => machines[i].kind === kind)
      expect(counts.total).toBe(ofKind.length)
      expect(counts.free + counts.done + counts.out).toBeLessThanOrEqual(counts.total)
      expect(counts.nextAt !== undefined).toBe(counts.free === 0 && ofKind.some(({ state }) => state === "running" || state === "done"))
      if (counts.nextAt !== undefined)
        expect(counts.nextAt).toBe(Math.min(...ofKind.filter(a => a.readyAt !== undefined && a.state !== "free").map(a => a.readyAt!)))
    }
  }))
)

test("Stoke G05 at 16:33: dryer 7's own countdown, dryer 10 waiting to be emptied, and washer 3 free", () => {
  const machines = snapshot("163302")
  const byNumber = (number: string) => assess(machines.find(m => m.number === number)!, NOW)
  expect(byNumber("7")).toEqual({ state: "running", basis: "reported", readyAt: Date.parse("2026-10-07T16:52:49.401Z") })
  expect(byNumber("10")).toMatchObject({ state: "done", basis: "reported" })
  expect(byNumber("3")).toEqual({ state: "free", basis: "reported" })
  expect(summarize(machines, machines.map(m => assess(m, NOW)))).toMatchObject({
    washer: { total: 6, free: 6, done: 0, out: 0 },
    dryer:  { total: 5, free: 0, done: 1, out: 0, isSure: false }
  })
})

test("a room's machines come by number with out-of-order ones last, so a stacked pair sits side by side unless one is out", () =>
  fc.assert(fc.property(fc.array(fc.tuple(machine, fc.integer({ min: 1, max: 20 }), fc.boolean()), { maxLength: 16 }), now, (list, t) => {
    const machines = list.map(([m, number, isPaired], i) => ({ ...m, id: `m${i}`, number: `${number}`, stack: isPaired ? number % 2 ? "upper" as const : "lower" as const : undefined }))
    const { machines: ordered, assessed, summary } = assessRoom({ at: t, isStale: false, machines, history: {} }, t)
    expect(ordered.map(m => m.id).sort()).toEqual(machines.map(m => m.id).sort())
    expect(assessed).toEqual(ordered.map(m => assess(m, t)))
    expect(summary).toEqual(summarize(ordered, assessed))
    const outs = assessed.map(({ state }) => state === "out")
    expect(outs).toEqual(outs.toSorted())
    for (let i = 1; i < ordered.length; i++)
      if (outs[i - 1] === outs[i])
        expect(+ordered[i - 1].number).toBeLessThanOrEqual(+ordered[i].number)
  }))
)

test("which of a stacked pair a machine is comes from the vendor's type name, and a single one is neither", () => {
  const upstream = (name: string): UpstreamMachine =>
    ({ id: "x", machineNumber: "07", modelNumber: "SDG", machineType: { name, isWasher: false, isDryer: true }, status: { statusId: "AVAILABLE", receivedAt: "2026-10-07T16:00:00Z", remainingSeconds: 0 } })
  expect(normalize("r", upstream("Stack Dryer Upper")).stack).toBe("upper")
  expect(normalize("r", upstream("Stack Dryer Lower")).stack).toBe("lower")
  expect(normalize("r", upstream("Single Dryer")).stack).toBeUndefined()
  expect(snapshot("163302").every(m => m.stack === undefined)).toBe(true)
})
