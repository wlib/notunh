import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { type Event, LINGER, isOn, pinPath, placeNames, placeOf, today, upcoming } from "../../src/social/event.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { DAY, addDays, dayStart, localDay } from "../../src/shared/time.mts"

const { places: gazetteer }: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))

const event = (start: number, end: number, id = "x"): Event =>
  ({ id, title: "T", start, end, where: "", source: "pin", url: "" })

test("today's list has what's on the day and not long over, soonest first, whatever the day or the hour", () =>
  fc.assert(fc.property(
    // Any moment within a few years of now, so the days and the clock changes vary
    fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: DAY - 1 }),
    fc.array(fc.record({ offset: fc.integer({ min: -3 * DAY, max: 3 * DAY }), length: fc.integer({ min: 0, max: 6 * 3_600_000 }) }), { maxLength: 12 }),
    (days, ms, items) => {
      const now = dayStart(localDay(Date.now())) + days * DAY + ms
      const day = localDay(now)
      const events = items.map(({ offset, length }, i) => event(now + offset, now + offset + length, `e${i}`))
      const list = today(events, now)
      for (const [i, item] of list.entries()) {
        expect(localDay(item.start) <= day && localDay(item.end) >= day).toBe(true)
        expect(item.end + LINGER).toBeGreaterThan(now)
        if (i)
          expect(item.start).toBeGreaterThanOrEqual(list[i - 1].start)
      }
      for (const item of events)
        if (!list.includes(item))
          expect(item.end + LINGER <= now || localDay(item.start) > day || localDay(item.end) < day).toBe(true)
    }
  ))
)

test("an event over by more than the linger is off the list, one just over stays, and one later today is on it", () => {
  // Noon today, whenever today is, so what's an hour or two either side is still today
  const day = localDay(Date.now())
  const now = dayStart(day) + 12 * 3_600_000
  expect(isOn(event(now - 3 * 3_600_000, now - LINGER - 1), day, now)).toBe(false)
  expect(isOn(event(now - 3 * 3_600_000, now - LINGER + 60_000), day, now)).toBe(true)
  expect(isOn(event(now + 60_000, now + 120_000), day, now)).toBe(true)
  expect(isOn(event(now + DAY, now + DAY + 120_000), day, now)).toBe(false)
})

test("a name resolves to the gazetteer place nearest campus of that name, and nothing to no place", () => {
  const names = placeNames(gazetteer)
  expect(names).toEqual([...new Set(names)])
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")))
  for (const name of names.slice(0, 50))
    expect(placeOf(gazetteer, name)).toMatchObject({ name })
  expect(placeOf(gazetteer, "Nowhere Hall")).toBeUndefined()
  expect(placeOf(gazetteer, undefined)).toBeUndefined()
  const thompson = placeOf(gazetteer, "Thompson Hall")!
  expect(thompson.lat).toBeCloseTo(43.136, 2)
  expect(thompson.lon).toBeCloseTo(-70.934, 2)
})

test("a pin's path is under /p/ with its id as it is", () => {
  expect(pinPath("abc-DEF_123")).toBe("/p/abc-DEF_123")
})

test("the days to come list each day after today that has something on, in order, soonest first, never today, and nothing past the days asked", () =>
  fc.assert(fc.property(
    fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: DAY - 1 }), fc.integer({ min: 0, max: 21 }),
    fc.array(fc.record({ offset: fc.integer({ min: -3 * DAY, max: 25 * DAY }), length: fc.integer({ min: 0, max: 30 * 3_600_000 }) }), { maxLength: 16 }),
    (days, ms, ahead, items) => {
      const now = dayStart(localDay(Date.now())) + days * DAY + ms
      const day = localDay(now)
      const events = items.map(({ offset, length }, i) => event(now + offset, now + offset + length, `e${i}`))
      const list = upcoming(events, now, ahead)
      for (const [i, { day: on, events: listed }] of list.entries()) {
        expect(on > day && on <= addDays(day, ahead)).toBe(true)
        expect(listed.length).toBeGreaterThan(0)
        if (i)
          expect(on > list[i - 1].day).toBe(true)
        for (const [j, item] of listed.entries()) {
          expect(isOn(item, on, now)).toBe(true)
          if (j)
            expect(item.start).toBeGreaterThanOrEqual(listed[j - 1].start)
        }
      }
      // Every event on a day within reach is listed under that day
      for (const item of events)
        for (let i = 1; i <= ahead; i++) {
          const on = addDays(day, i)
          if (isOn(item, on, now))
            expect(list.find(listed => listed.day === on)?.events).toContain(item)
        }
    }
  ))
)
