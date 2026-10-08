import { test, expect } from "vitest"
import fc from "fast-check"
import { HALF_LIFE, decay, foldDay, rounded, type Learned } from "../../src/shared/learn.mts"
import { addDays, type Day } from "../../src/shared/time.mts"

/** A model learning how many things happen a day and how long they take in all */
type Toy = Learned & { n: number, sum: number }

const empty = (): Toy => ({ version: 1, through: null, n: 0, sum: 0 })
const scale = (toy: Toy, by: number): Toy => ({ ...toy, n: toy.n * by, sum: toy.sum * by })
const fold = (toy: Toy, day: Day, seen: readonly number[]) =>
  foldDay(toy, day, scale, before => ({ ...before, n: before.n + seen.length, sum: seen.reduce((sum, x) => sum + x, before.sum) }))

// The Saturday before the clocks fall back, so the days folded cross that and, a few months on, springing forward
const START = "2026-10-31"

/** Days with what was seen on each, some days apart, never fewer than one */
const days = fc.array(
  fc.record({ gap: fc.integer({ min: 1, max: 60 }), seen: fc.array(fc.double({ min: 0, max: 1e3, noNaN: true }), { maxLength: 6 }) }),
  { minLength: 1, maxLength: 12 }
).map(entries => {
  let day = START
  return entries.map(({ gap, seen }) => ({ day: day = addDays(day, gap), seen }))
})

const foldAll = (toy: Toy, entries: readonly { day: Day, seen: readonly number[] }[]) =>
  entries.reduce((toy, { day, seen }) => fold(toy, day, seen), toy)

test("decay halves every half-life and composes over the days between", () => {
  expect(decay(0)).toBe(1)
  expect(decay(HALF_LIFE)).toBe(0.5)
  fc.assert(fc.property(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 400 }), (a, b) => {
    expect(decay(a) * decay(b)).toBeCloseTo(decay(a + b), 12)
  }))
})

test("folding is deterministic and resumable: a model stored as JSON folds on as one that never was", () =>
  fc.assert(fc.property(days, fc.nat(), (entries, cut) => {
    const split = cut % (entries.length + 1)
    const whole = foldAll(empty(), entries)
    const stored = JSON.parse(JSON.stringify(foldAll(empty(), entries.slice(0, split)))) as Toy
    expect(foldAll(stored, entries.slice(split))).toEqual(whole)
    expect(foldAll(empty(), entries)).toEqual(whole)
    expect(rounded(whole)).toEqual(whole)
    expect(whole.through).toBe(entries.at(-1)!.day)
  }))
)

test("folding in a day already folded in, or one before it, changes nothing", () =>
  fc.assert(fc.property(days, fc.nat(), fc.array(fc.double({ min: 0, max: 1e3, noNaN: true })), (entries, pick, again) => {
    const toy = foldAll(empty(), entries)
    const { day } = entries[pick % entries.length]
    expect(fold(toy, day, again)).toBe(toy)
    expect(fold(toy, addDays(day, -1), again)).toBe(toy)
  }))
)

test("what's been learned halves every half-life, however the days between are folded, and whatever the clocks do", () =>
  fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 1e3, noNaN: true }), { minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: HALF_LIFE }), (seen, step) => {
    const start = fold(empty(), START, seen)
    const later = fold(start, addDays(START, HALF_LIFE), [])
    let stepped = start
    for (let day = step; day < HALF_LIFE; day += step)
      stepped = fold(stepped, addDays(START, day), [])
    stepped = fold(stepped, addDays(START, HALF_LIFE), [])
    expect(later.n).toBeCloseTo(start.n / 2, 3)
    expect(stepped.n).toBeCloseTo(later.n, 2)
    expect(stepped.sum).toBeCloseTo(later.sum, 1)
  }))
)

test("a gap decays by how long it was, as one step", () =>
  fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 1e3, noNaN: true }), { minLength: 1 }), fc.integer({ min: 1, max: 400 }), (seen, gap) => {
    const start = fold(empty(), START, seen)
    expect(fold(start, addDays(START, gap), [])).toEqual({ ...rounded(scale(start, decay(gap))), through: addDays(START, gap) })
  }))
)

test("the first day folds in as it is, with nothing before it to decay", () =>
  fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 1e3, noNaN: true })), seen => {
    expect(fold(empty(), START, seen)).toEqual(rounded({ version: 1, through: START, n: seen.length, sum: seen.reduce((sum, x) => sum + x, 0) }))
  }))
)
