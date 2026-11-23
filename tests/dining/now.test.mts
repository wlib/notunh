import { test, expect } from "vitest"
import fc from "fast-check"
import { MINUTES_A_DAY, status, wallDate, type WallTime } from "../../src/dining/hours.mts"
import { SOON_MINUTES, diningNow, mealHour, minutesBetween } from "../../src/dining/now.mts"
import { addDays, type Day } from "../../src/shared/time.mts"
import type { Hours, Span } from "../../src/dining/menus.mts"

// A Monday, from which any day of a few weeks is drawn
const MONDAY: Day = "2026-10-05"

// A day's spans in quarter hours: none, or one, which may run past midnight
const daySpans: fc.Arbitrary<Span[]> = fc.oneof(
  fc.constant<Span[]>([]),
  fc.tuple(fc.integer({ min: 0, max: 95 }), fc.integer({ min: 1, max: 96 })).map(([open, length]): Span[] => [[open * 15, (open + length) * 15]])
)

const hours: fc.Arbitrary<Hours> = fc.array(daySpans, { minLength: 7, maxLength: 7 }).map(week => ({ week }))

const wallTime: fc.Arbitrary<WallTime> = fc.record({
  day:    fc.integer({ min: 0, max: 27 }).map(offset => addDays(MONDAY, offset)),
  minute: fc.integer({ min: 0, max: MINUTES_A_DAY - 1 })
})

/** Halls with hours, or some without, as they'd be at a minute */
const hallsAt = (all: (Hours | undefined)[], now: WallTime) =>
  all.map((hours, i) => ({ id: `hall-${i}`, standing: hours && status(hours, now) }))

test("the halls open are every hall open, in their order, and those about to are within the hour", () =>
  fc.assert(fc.property(fc.array(fc.option(hours, { nil: undefined }), { maxLength: 4 }), wallTime, (all, now) => {
    const halls = hallsAt(all, now)
    const { open, serving } = diningNow(halls, now)
    expect(open).toEqual(halls.filter(hall => hall.standing?.isOpen))
    expect(serving.filter(hall => hall.standing?.isOpen)).toEqual(open)
    expect(halls.filter(hall => serving.includes(hall))).toEqual(serving)
    for (const hall of halls) {
      const { standing } = hall
      const isSoon = standing?.isOpen === false && standing.opens !== undefined && minutesBetween(now, standing.opens) <= SOON_MINUTES
      expect(serving.includes(hall)).toBe(standing?.isOpen === true || isSoon)
    }
  }))
)

test("the next to open is the closed hall that opens soonest, after now, and none where no closed hall opens", () =>
  fc.assert(fc.property(fc.array(fc.option(hours, { nil: undefined }), { maxLength: 4 }), wallTime, (all, now) => {
    const halls = hallsAt(all, now)
    const { next } = diningNow(halls, now)
    const opening = halls.flatMap(({ standing }) => standing && !standing.isOpen && standing.opens ? [wallDate(standing.opens).getTime()] : [])
    expect(next === undefined).toBe(!opening.length)
    if (next) {
      expect(wallDate(next.opens).getTime()).toBe(Math.min(...opening))
      expect(next.hall.standing).toEqual({ isOpen: false, opens: next.opens })
      expect(minutesBetween(now, next.opens)).toBeGreaterThan(0)
    }
  }))
)

test("a hall about to open is only so in its last hour, and open from the minute it opens", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 95 }), fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 6 }), (open, length, offset) => {
    // Open each day for at most ten hours, so a day's hours never run on into the next day's last hour before opening
    const week: Span[][] = Array.from({ length: 7 }, () => [[open * 15, (open + length) * 15]])
    const at = (minute: number) => {
      const now = { day: addDays(MONDAY, offset), minute }
      return diningNow([{ standing: status({ week }, now) }], now)
    }
    if (open * 15 - SOON_MINUTES - 1 >= 0)
      expect(at(open * 15 - SOON_MINUTES - 1).serving).toHaveLength(0)
    if (open * 15 - SOON_MINUTES >= 0)
      expect(at(open * 15 - SOON_MINUTES).serving).toHaveLength(1)
    expect(at(open * 15).open).toHaveLength(1)
  }))
)

// The halls' usual hours: Holloway every day, from 8:00 at weekends, and Philbrook on weekdays
const HOLLOWAY: Hours = { week: [...Array(5).fill([[435, 1260]]), [[480, 1260]], [[480, 1260]]] }
const PHILBROOK: Hours = { week: [...Array(5).fill([[435, 1260]]), [], []] }

const campusAt = (now: WallTime, holloway = HOLLOWAY, philbrook = PHILBROOK) =>
  diningNow([{ name: "Holloway Commons", standing: status(holloway, now) }, { name: "Philbrook Hall", standing: status(philbrook, now) }], now)

const names = (halls: { name: string }[]) =>
  halls.map(({ name }) => name)

test("a weekday through the day: about to open, both serving, then closed till the morning", () => {
  const wednesday = addDays(MONDAY, 2)
  const at = (hour: number, minute = 0) => campusAt({ day: wednesday, minute: hour * 60 + minute })
  expect(names(at(6, 0).serving)).toEqual([])
  expect(at(6, 0).next).toMatchObject({ hall: { name: "Holloway Commons" }, opens: { day: wednesday, minute: 435 } })
  expect(names(at(6, 30).serving)).toEqual(["Holloway Commons", "Philbrook Hall"])
  expect(at(6, 30).open).toEqual([])
  expect(names(at(12).open)).toEqual(["Holloway Commons", "Philbrook Hall"])
  expect(at(12).open[0].standing.closes).toEqual({ day: wednesday, minute: 1260 })
  expect(names(at(20, 59).open)).toHaveLength(2)
  expect(at(21).serving).toEqual([])
  expect(at(23).next?.opens).toEqual({ day: addDays(wednesday, 1), minute: 435 })
})

test("a weekend, with Philbrook closed, and a break that closes both for days", () => {
  const saturday = addDays(MONDAY, 5)
  expect(names(campusAt({ day: saturday, minute: 12 * 60 }).serving)).toEqual(["Holloway Commons"])
  expect(names(campusAt({ day: saturday, minute: 7 * 60 + 15 }).serving)).toEqual(["Holloway Commons"])
  expect(campusAt({ day: addDays(saturday, 1), minute: 23 * 60 }).next).toMatchObject({ hall: { name: "Holloway Commons" }, opens: { minute: 435 } })

  // Thanksgiving: Holloway closed from Wednesday on, Philbrook all week, so the next opening is the Monday after
  const monday = addDays(MONDAY, 7)
  const closed = { spans: [], note: "Thanksgiving Holiday" }
  const holiday: Hours = { ...HOLLOWAY, special: Object.fromEntries([2, 3, 4, 5, 6].map(offset => [addDays(monday, offset), closed])) }
  const shut: Hours = { week: Array(7).fill([]) }
  const wednesday = campusAt({ day: addDays(monday, 2), minute: 12 * 60 }, holiday, shut)
  expect(wednesday.open).toEqual([])
  expect(wednesday.serving).toEqual([])
  expect(wednesday.next).toMatchObject({ hall: { name: "Holloway Commons" }, opens: { day: addDays(monday, 7), minute: 435 } })
  expect(campusAt({ day: monday, minute: 12 * 60 }, shut, shut)).toEqual({ open: [], serving: [] })
})

test("a hall's meal is now's while it's open, its opening's later today, and now's when it opens another day", () => {
  const day = addDays(MONDAY, 2)
  expect(mealHour({ isOpen: true, closes: { day, minute: 1260 } }, { day, minute: 12 * 60 + 30 })).toBe(12)
  expect(mealHour({ isOpen: false, opens: { day, minute: 17 * 60 } }, { day, minute: 15 * 60 + 30 })).toBe(17)
  expect(mealHour({ isOpen: false, opens: { day: addDays(day, 1), minute: 435 } }, { day, minute: 22 * 60 })).toBe(22)
  expect(mealHour(undefined, { day, minute: 9 * 60 })).toBe(9)
})
