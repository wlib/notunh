import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { Curated, type Series, fromCurated } from "../../src/social/curated.mts"
import { WEEKDAYS } from "../../src/social/when.mts"
import { addDays, atClock, localDay, weekday } from "../../src/shared/time.mts"

const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const match = placeMatcher(gazetteer.places.map(place => place.name))

/** Today, as each run of the tests has it */
const today = localDay(Date.now())

/** A series, its days within some weeks of today */
const series = fc.record({
  days:   fc.uniqueArray(fc.constantFrom(...WEEKDAYS), { minLength: 1, maxLength: 7 }),
  from:   fc.integer({ min: -30, max: 30 }),
  length: fc.integer({ min: 0, max: 120 }),
  hour:   fc.integer({ min: 7, max: 21 })
}).map(({ days, from, length, hour }): Series => ({
  title: "Russian Conversation Hour", where: "Murkland G10 Lounge", days, start: `${String(hour).padStart(2, "0")}:00`, end: `${String(hour + 1).padStart(2, "0")}:00`,
  from: addDays(today, from), until: addDays(today, from + length), url: "https://cola.unh.edu/x", passage: "2-3pm every Friday", checked: today
}))

test("a series is on its weekdays from its first day until its last, at its times, and no other day", () =>
  fc.assert(fc.property(series, fc.integer({ min: 1, max: 60 }), (one, days) => {
    const events = fromCurated([one], today, days, match)
    const expected = Array.from({ length: days }, (_, i) => addDays(today, i)).filter(on => on >= one.from && on <= one.until && one.days.includes(WEEKDAYS[weekday(on)]))
    expect(events.map(({ start }) => localDay(start))).toEqual(expected)
    for (const event of events)
      expect(event).toMatchObject({ source: "curated", place: "Murkland Hall", checked: today, start: atClock(localDay(event.start), one.start), end: atClock(localDay(event.start), one.end) })
    expect(new Set(events.map(({ id }) => id)).size).toBe(events.length)
  })))

test("a series on named dates is on those alone, and one is either, not both", () => {
  fc.assert(fc.property(series, fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: 1 }), (one, offsets) => {
    const dates = offsets.map(i => addDays(today, i))
    const events = fromCurated([{ ...one, days: [], dates, from: today, until: addDays(today, 30) }], today, 31, match)
    expect(events.map(({ start }) => localDay(start)).sort()).toEqual([...dates].sort())
  }))
  fc.assert(fc.property(series, one => { expect(v.safeParse(Curated, [{ ...one, dates: [today] }]).success).toBe(false) }))
  // Neither is none at all
  fc.assert(fc.property(series, one => { expect(v.safeParse(Curated, [{ ...one, days: [], dates: [] }]).success).toBe(false) }))
})

test("two series of one title on one day are told apart by their start", () =>
  fc.assert(fc.property(series, one => {
    const later = { ...one, start: `${String(+one.start.slice(0, 2) + 1).padStart(2, "0")}:00`, end: `${String(+one.end.slice(0, 2) + 1).padStart(2, "0")}:00` }
    const events = fromCurated([one, later], today, 30, match)
    expect(new Set(events.map(({ id }) => id)).size).toBe(events.length)
  })))

test("the series kept are ones the schema takes", async () => {
  const curated = JSON.parse(await readFile(new URL("../../src/social/curated.json", import.meta.url), "utf8"))
  expect(() => v.parse(Curated, curated)).not.toThrow()
})

