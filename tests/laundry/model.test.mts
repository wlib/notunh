import { test, expect } from "vitest"
import fc from "fast-check"
import type { Known, Poll, Status, Transition } from "../../src/laundry/infer.mts"
import { SLOTS, accumulate, bundle, coverage, emptyLearned, emptyStats, occupancy, pollMinutes, quantize, unpack, update, type Learned, type Stats } from "../../src/laundry/model.mts"
import { HOUR, addDays, dayStart, type Day } from "../../src/shared/time.mts"

const MACHINES = ["a", "b", "c", "d"]
const status = fc.constantFrom<Status>("free", "running", "done", "out")
const DAY_FROM = dayStart("2026-10-07")
const DAY_TO = dayStart("2026-10-08")

const transitions = fc
  .array(fc.record({ machine: fc.constantFrom(...MACHINES), at: fc.integer({ min: DAY_FROM - 4 * HOUR, max: DAY_TO + 4 * HOUR }), status }), { maxLength: 30 })
  .map(list => list
    .map(({ machine, at, status }): Transition => ({ machine, room: "r", at, status, raw: "", remaining: 0 }))
    .sort((a, b) => a.at - b.at)
  )

const initial = fc
  .subarray(MACHINES)
  .chain(machines => fc.tuple(...machines.map(machine => fc.tuple(fc.constant(machine), status))))
  .map(entries => new Map(entries))

test("a day's free count steps through it without gaps or overlaps, within how many machines there are, and ignores what's outside it", () =>
  fc.assert(fc.property(initial, transitions, (start, list) => {
    const steps = occupancy(start, list, DAY_FROM, DAY_TO)
    expect(steps[0].from).toBe(DAY_FROM)
    expect(steps.at(-1)!.to).toBe(DAY_TO)
    for (const [i, step] of steps.entries()) {
      expect(step.to).toBeGreaterThan(step.from)
      expect(step.free).toBeGreaterThanOrEqual(0)
      expect(step.free).toBeLessThanOrEqual(MACHINES.length)
      if (i)
        expect(step.from).toBe(steps[i - 1].to)
    }
    expect(occupancy(start, list.filter(({ at }) => at >= DAY_FROM && at < DAY_TO), DAY_FROM, DAY_TO)).toEqual(steps)
  }))
)

const polls = fc
  .array(fc.record({ gap: fc.integer({ min: 1, max: 40 }), failed: fc.subarray(["r", "s"]) }), { maxLength: 400 })
  .map(list => {
    let at = DAY_FROM - HOUR
    return list.map(({ gap, failed }): Poll => ({ at: at += gap * 60_000, failed }))
  })

test("a room counts as watched only between runs close together that both fetched it", () =>
  fc.assert(fc.property(polls, list => {
    const spans = coverage(list, "r", DAY_FROM, DAY_TO)
    for (const [i, span] of spans.entries()) {
      expect(span.from).toBeGreaterThanOrEqual(DAY_FROM)
      expect(span.to).toBeLessThanOrEqual(DAY_TO)
      expect(span.to).toBeGreaterThan(span.from)
      if (i)
        expect(span.from).toBeGreaterThan(spans[i - 1].to)
    }
    const total = (spans: { from: number, to: number }[]) => spans.reduce((sum, { from, to }) => sum + to - from, 0)
    const watched = list.slice(1).reduce((sum, b, i) => {
      const a = list[i]
      const isWatched = !a.failed.includes("r") && !b.failed.includes("r") && b.at - a.at <= 2 * pollMinutes(a.at) * 60_000
      return sum + (isWatched ? Math.max(0, Math.min(b.at, DAY_TO) - Math.max(a.at, DAY_FROM)) : 0)
    }, 0)
    expect(total(spans)).toBe(watched)
    expect(coverage(list.map(poll => ({ ...poll, failed: ["r"] })), "r", DAY_FROM, DAY_TO)).toEqual([])
  }))
)

test("two runs 5 minutes apart cover what's between, and runs further apart than twice the interval cover nothing", () => {
  const at = DAY_FROM + 12 * HOUR
  expect(coverage([{ at, failed: [] }, { at: at + 300_000, failed: [] }], "r", DAY_FROM, DAY_TO)).toEqual([{ from: at, to: at + 300_000 }])
  expect(coverage([{ at, failed: [] }, { at: at + 660_000, failed: [] }], "r", DAY_FROM, DAY_TO)).toEqual([])
})

const close = (a: Stats, b: Stats) => {
  for (const key of ["free", "any", "weight"] as const)
    for (let h = 0; h < SLOTS; h++)
      expect(a[key][h]).toBeCloseTo(b[key][h], 6)
}

const plus = (a: Stats, b: Stats): Stats =>
  ({ free: a.free.map((x, h) => x + b.free[h]), any: a.any.map((x, h) => x + b.any[h]), weight: a.weight.map((x, h) => x + b.weight[h]) })

test("a day adds just what was watched, which stays within the room and an hour's worth a day", () =>
  fc.assert(fc.property(fc.array(fc.tuple(initial, transitions, polls), { minLength: 1, maxLength: 4 }), days => {
    let stats = emptyStats()
    for (const [start, list, run] of days) {
      const steps = occupancy(start, list, DAY_FROM, DAY_TO)
      const covered = coverage(run, "r", DAY_FROM, DAY_TO)
      const next = accumulate(stats, steps, covered)
      close(next, plus(stats, accumulate(emptyStats(), steps, covered)))
      expect(accumulate(stats, steps, [])).toEqual(stats)
      stats = next
    }
    for (let h = 0; h < SLOTS; h++) {
      expect(stats.weight[h]).toBeLessThanOrEqual(days.length * 3600 + 1e-6)
      if (stats.weight[h]) {
        expect(stats.free[h] / stats.weight[h]).toBeLessThanOrEqual(MACHINES.length + 1e-9)
        expect(stats.any[h] / stats.weight[h]).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  }))
)

test("quantizing keeps order, clamps, and reads back within a step", () =>
  fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 30, noNaN: true }), { minLength: SLOTS, maxLength: SLOTS }), means => {
    const hours = 3
    const stats: Stats = { free: means.map(x => x * hours * 3600), any: means.map(x => Math.min(1, x / 30) * hours * 3600), weight: Array(SLOTS).fill(hours * 3600) }
    const read = unpack(quantize(stats, 4)).map(week => week!.free)
    for (let h = 0; h < SLOTS; h++)
      expect(read[h]).toBeCloseTo(Math.min(means[h], 255 / 16), 1)
    const byMean = means.map((mean, h) => [mean, read[h]]).sort(([a], [b]) => a - b).map(([, free]) => free)
    expect(byMean).toEqual(byMean.toSorted((a, b) => a - b))
  }))
)

/** Folds days in one at a time, as nightly builds do */
const learnDays = (machines: Known[], transitions: Transition[], polls: Poll[], from: Day, through: Day) => {
  let learned: Learned = emptyLearned()
  for (let day = from; day <= through; day = addDays(day, 1))
    learned = update(learned, machines, day, transitions.filter(({ at }) => at >= dayStart(day) && at < dayStart(addDays(day, 1))), polls)
  return learned
}

test("a room watched for weeks with one washer free and one busy says so, and says nothing for a kind it lacks", () => {
  const machines: Known[] = [{ machine: "a", room: "r", kind: "washer" }, { machine: "b", room: "r", kind: "washer" }]
  const from = dayStart("2026-09-01")
  const transitions: Transition[] = [
    { machine: "a", room: "r", at: from, status: "free", raw: "AVAILABLE", remaining: 0 },
    { machine: "b", room: "r", at: from, status: "running", raw: "IN_USE", remaining: 0 }
  ]
  const polls: Poll[] = []
  for (let at = from; at < dayStart("2026-10-01"); at += 5 * 60_000)
    polls.push({ at, failed: [] })
  const learned = learnDays(machines, transitions, polls, "2026-09-01", "2026-09-30")
  const usual = bundle(learned, machines)
  expect(usual.through).toBe("2026-09-30")
  expect(Object.keys(usual.rooms.r)).toEqual(["washer"])
  expect(usual.rooms.r.washer!.total).toBe(2)
  for (const hour of unpack(usual.rooms.r.washer!))
    expect(hour).toEqual({ free: 1, any: 1 })
  // What's carried between nights survives being stored as JSON, and a day fed twice changes nothing
  expect(JSON.parse(JSON.stringify(learned))).toEqual(learned)
  expect(update(learned, machines, "2026-09-30", transitions, polls)).toBe(learned)
})

test("a day with next to no business, like the first of a break, teaches nothing about that hour of the week", () => {
  const machines: Known[] = [{ machine: "a", room: "r", kind: "washer" }]
  const transitions: Transition[] = []
  const polls: Poll[] = []
  // Two weeks of a washer running every other hour, then a day it sits free
  let day = "2026-09-01"
  for (let i = 0; i < 15; i++, day = addDays(day, 1))
    for (let at = dayStart(day); at < dayStart(addDays(day, 1)); at += HOUR) {
      if (i < 14)
        transitions.push({ machine: "a", room: "r", at, status: (at / HOUR) % 2 ? "running" : "free", raw: "", remaining: 0 })
      for (let poll = at; poll < at + HOUR; poll += 5 * 60_000)
        polls.push({ at: poll, failed: [] })
    }
  const free = (through: Day) =>
    unpack(bundle(learnDays(machines, transitions, polls, "2026-09-01", through), machines).rooms.r.washer!).map(hour => hour?.free)
  expect(free("2026-09-15")).toEqual(free("2026-09-14"))
})
