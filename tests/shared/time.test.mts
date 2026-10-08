import { test, expect } from "vitest"
import fc from "fast-check"
import { DAY, HOUR, TIME_ZONE, addDays, dayStart, daysBetween, localDay, localHour, localMinutes, offsetAt, weekday, type Day } from "../../src/shared/time.mts"

const SPRING = "2026-03-08"
const FALL   = "2026-11-01"

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const wall = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23"
})
const wallAt = (ms: number) =>
  Object.fromEntries(wall.formatToParts(ms).map(({ type, value }) => [type, value]))

const dayOf = (date: Date): Day =>
  date.toISOString().slice(0, 10)

/** Any day this century, and often one around the clock changes of 2026 */
const day = fc.oneof(
  fc.date({ min: new Date("2000-01-01T12:00:00Z"), max: new Date("2099-12-31T12:00:00Z"), noInvalidDate: true }).map(dayOf),
  fc.integer({ min: -2, max: 2 }).chain(n => fc.constantFrom(addDays(SPRING, n), addDays(FALL, n)))
)

/** Any moment of 2026, and often one within hours of either clock change or a midnight */
const instant = fc.oneof(
  fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) }),
  fc.integer({ min: Date.parse("2026-03-08T00:00:00Z"), max: Date.parse("2026-03-09T12:00:00Z") }),
  fc.integer({ min: Date.parse("2026-11-01T00:00:00Z"), max: Date.parse("2026-11-02T12:00:00Z") }),
  fc.tuple(fc.date({ min: new Date("2026-01-01"), max: new Date("2026-12-31"), noInvalidDate: true }), fc.integer({ min: -HOUR, max: HOUR }))
    .map(([date, ms]) => dayStart(dayOf(date)) + ms)
)

test("the offset is what Durham's wall clock reads less UTC's: four hours behind in summer, five in winter", () => {
  expect(offsetAt(Date.parse("2026-07-01T12:00:00Z"))).toBe(-4 * HOUR)
  expect(offsetAt(Date.parse("2026-01-01T12:00:00Z"))).toBe(-5 * HOUR)
  // The instants the clocks change, 2 AM by the clock they leave
  expect(offsetAt(Date.parse("2026-03-08T07:00:00Z") - 1)).toBe(-5 * HOUR)
  expect(offsetAt(Date.parse("2026-03-08T07:00:00Z"))).toBe(-4 * HOUR)
  expect(offsetAt(Date.parse("2026-11-01T06:00:00Z") - 1)).toBe(-4 * HOUR)
  expect(offsetAt(Date.parse("2026-11-01T06:00:00Z"))).toBe(-5 * HOUR)
  fc.assert(fc.property(instant, ms => {
    const { year, month, day, hour, minute } = wallAt(ms)
    expect(Date.UTC(+year, +month - 1, +day, +hour, +minute)).toBe(Math.floor(ms / 60_000) * 60_000 + offsetAt(ms))
  }))
})

test("the local day, hour, and minute are Durham's wall clock's, through both clock changes", () =>
  fc.assert(fc.property(instant, ms => {
    const { year, month, day, weekday: name, hour, minute } = wallAt(ms)
    expect(localDay(ms)).toBe(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`)
    expect(localHour(ms)).toBe(+hour)
    expect(localMinutes(ms)).toBe(+hour * 60 + +minute)
    // Laundry's hour of the week, Monday midnight first
    expect(weekday(localDay(ms)) * 24 + localHour(ms)).toBe(WEEKDAYS.indexOf(name) * 24 + +hour)
  }))
)

test("a day starts at Durham's midnight, which is the last moment of the day before plus one", () =>
  fc.assert(fc.property(day, d => {
    const start = dayStart(d)
    expect(localDay(start)).toBe(d)
    expect(localMinutes(start)).toBe(0)
    expect(localDay(start - 1)).toBe(addDays(d, -1))
  }))
)

test("every instant falls in the day that starts at or before it and ends after", () =>
  fc.assert(fc.property(instant, ms => {
    const d = localDay(ms)
    expect(dayStart(d)).toBeLessThanOrEqual(ms)
    expect(dayStart(addDays(d, 1))).toBeGreaterThan(ms)
  }))
)

test("days run 24 hours, but 23 when the clocks spring forward and 25 when they fall back", () => {
  expect(dayStart(SPRING)).toBe(Date.parse("2026-03-08T05:00:00Z"))
  expect(dayStart(addDays(SPRING, 1))).toBe(Date.parse("2026-03-09T04:00:00Z"))
  expect(dayStart(FALL)).toBe(Date.parse("2026-11-01T04:00:00Z"))
  expect(dayStart(addDays(FALL, 1))).toBe(Date.parse("2026-11-02T05:00:00Z"))
  fc.assert(fc.property(fc.integer({ min: 0, max: 364 }), n => {
    const d = addDays("2026-01-01", n)
    expect(dayStart(addDays(d, 1)) - dayStart(d)).toBe(d === SPRING ? 23 * HOUR : d === FALL ? 25 * HOUR : DAY)
  }))
  fc.assert(fc.property(day, d => {
    expect(dayStart(addDays(d, 1)) - dayStart(d)).toBeOneOf([23 * HOUR, DAY, 25 * HOUR])
  }))
})

test("adding days round trips, is monotone as text, and counts back as daysBetween, across clock changes and years", () =>
  fc.assert(fc.property(day, fc.integer({ min: -800, max: 800 }), (d, n) => {
    const later = addDays(d, n)
    expect(later).toMatch(/^\d{4}-\d\d-\d\d$/)
    expect(addDays(later, -n)).toBe(d)
    expect(Math.sign(later.localeCompare(d))).toBe(Math.sign(n))
    expect(daysBetween(d, later)).toBe(n)
    // The next day starts within 25 hours, and runs at least 23
    expect(localDay(dayStart(d) + 25 * HOUR)).toBe(addDays(d, 1))
  }))
)

test("weekdays run Monday 0 to Sunday 6 as Durham's calendar has them, one more each day", () => {
  expect(weekday("2026-10-05")).toBe(0)
  expect(weekday("2026-10-11")).toBe(6)
  fc.assert(fc.property(day, fc.integer({ min: -800, max: 800 }), (d, n) => {
    expect(weekday(d)).toBe(WEEKDAYS.indexOf(wallAt(dayStart(d) + 12 * HOUR).weekday))
    expect(weekday(addDays(d, n))).toBe(((weekday(d) + n) % 7 + 7) % 7)
  }))
})
