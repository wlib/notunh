import { test, expect } from "vitest"
import fc from "fast-check"
import { type Permit, type Stay, type Who, fits, holds, inWinterSeason, options, paidStretches, segments, startOf, stateAt, walkFrom } from "../../src/parking/model.mts"
import { type Day, HOUR, addDays, atClock, dayStart, localDay, localMinutes, offsetAt, weekday } from "../../src/shared/time.mts"
import { areas } from "./fixtures.mts"

const today: Day = "2026-10-28"
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`

/** A day within half a year of today either way, so both clock changes and a winter are crossed */
const aDay = fc.integer({ min: -180, max: 180 }).map(days => addDays(today, days))
const anInstant = fc.tuple(aDay, fc.integer({ min: 0, max: 1439 })).map(([day, minute]) => atClock(day, clock(minute)))
/** A stay from a few minutes to three days */
const aStay: fc.Arbitrary<Stay> = fc.tuple(anInstant, fc.integer({ min: 5, max: 72 * 60 })).map(([from, minutes]) => ({ from, to: from + minutes * 60_000 }))
/** Some UNH holidays among those days */
const someHolidays = fc.uniqueArray(aDay, { maxLength: 8 })
const anArea = fc.constantFrom(...areas)
const aPermit: fc.Arbitrary<Permit | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom<Permit>("commuter", "faculty", "resident-west", "non-resident"),
  fc.constantFrom(...areas.flatMap(area => area.permits.filter(permit => typeof permit === "object")))
)
const aWho: fc.Arbitrary<Who> = fc.record({ permit: aPermit, purpose: fc.constantFrom<Who["purpose"]>(undefined, "class", "errand", "event", "visit") })

/** Some instants through a stay, its ends included */
const through = (stay: Stay, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => Math.min(stay.to - 1, stay.from + Math.floor((stay.to - stay.from) * i / n)))

test("the whole stay's verdict agrees with every instant of it, and its segments tile the stay saying what each instant says", () =>
  fc.assert(fc.property(anArea, aWho, aStay, someHolidays, (area, who, stay, holidays) => {
    const verdict = fits(area, who, stay, holidays)
    const states = through(stay).map(at => stateAt(area, who, at, holidays).kind)
    if (verdict.fits === "yes")
      expect(states.every(kind => kind === "free" || kind === "pay" || kind === "permit")).toBe(true)
    if (states.includes("closed"))
      expect(verdict.fits).toBe("no")
    expect(verdict.segments[0].from).toBe(stay.from)
    expect(verdict.segments.at(-1)!.to).toBe(stay.to)
    for (let i = 1; i < verdict.segments.length; i++)
      expect(verdict.segments[i].from).toBe(verdict.segments[i - 1].to)
    // Every instant, on a day the clocks change too, is in a segment of its own state
    for (const at of through(stay, 40))
      expect(verdict.segments.find(segment => segment.from <= at && at < segment.to)!.kind).toBe(stateAt(area, who, at, holidays).kind)
    expect(verdict.from).toBeGreaterThanOrEqual(stay.from)
    expect(verdict.from).toBeLessThanOrEqual(stay.to)
  }), { numRuns: 300 })
)

test("part of a stay that fits also fits: shortening a stay never turns a yes into anything else", () =>
  fc.assert(fc.property(anArea, aWho, aStay, someHolidays, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (area, who, stay, holidays, a, b) => {
    const [x, y] = [a, b].sort((p, q) => p - q)
    const span = stay.to - stay.from
    const from = stay.from + Math.floor(span * x)
    const part = { from, to: Math.max(from + 60_000, stay.from + Math.floor(span * y)) }
    fc.pre(part.to <= stay.to)
    if (fits(area, who, stay, holidays).fits === "yes")
      expect(fits(area, who, part, holidays).fits).toBe("yes")
  }), { numRuns: 300 })
)

test("early on a winter morning nothing is said to fit but a resident lot both sources keep open, and a lot closed anyway stays closed", () =>
  fc.assert(fc.property(anArea, aWho, anInstant, someHolidays, (area, who, at, holidays) => {
    const state = stateAt(area, who, at, holidays)
    const isWinterMorning = inWinterSeason(localDay(at)) && localMinutes(at) < 7 * 60
    if (!isWinterMorning)
      expect(state.kind).not.toBe("unknown")
    else if (state.kind !== "unknown")
      expect(state.kind === "closed" || (state.kind === "permit" && area.winter === "permit-holders")).toBe(true)
  }), { numRuns: 500 })
)

test("a stay that fits never needs more paid time at once than one payment covers, and its paid hours are its paid segments'", () =>
  fc.assert(fc.property(fc.constantFrom(...areas.filter(area => area.zone)), aWho, aStay, someHolidays, (area, who, stay, holidays) => {
    const verdict = fits(area, who, stay, holidays)
    if (verdict.fits === "yes")
      for (const stretch of paidStretches(verdict.segments))
        expect(stretch.to - stretch.from).toBeLessThanOrEqual(stretch.max * HOUR)
    const paid = verdict.segments.flatMap(segment => segment.kind === "pay" ? [segment] : [])
    expect(verdict.pay).toBeCloseTo(paid.reduce((sum, segment) => sum + (segment.to - segment.from), 0) / HOUR, 6)
    expect(verdict.cost).toBeCloseTo(paid.reduce((sum, segment) => sum + (segment.to - segment.from) / HOUR * segment.rate, 0), 6)
  }), { numRuns: 200 })
)

test("at an instant outside the ban: a resident lot is shut without its permit, a weekday lot opens to all outside weekdays 7 to 6 and on UNH holidays, and a zone charges inside its window", () =>
  fc.assert(fc.property(anArea, aWho, anInstant.filter(at => !inWinterSeason(localDay(at))), someHolidays, (area, who, at, holidays) => {
    const day = localDay(at)
    const minute = localMinutes(at)
    const state = stateAt(area, who, at, holidays)
    if (holds(area, who.permit))
      expect(state.kind).toBe("permit")
    else if (area.always && !area.zone)
      expect(state.kind).toBe("closed")
    else if (!area.zone && area.permits.length)
      expect(state.kind).toBe(weekday(day) < 5 && !holidays.includes(day) && 7 * 60 <= minute && minute < 18 * 60 ? "closed" : "free")
    else if (area.zone) {
      const paid = area.zone.paid.some(paid => paid.days.includes(weekday(day)) && paid.hours[0] <= minute && minute < paid.hours[1])
      expect(state.kind).toBe(paid && !holidays.includes(day) ? "pay" : "free")
    }
  }))
)

test("on the days the clocks change, every quarter hour is in a segment of its own state", () => {
  const changes = Array.from({ length: 366 }, (_, i) => addDays(today, i)).filter(day => offsetAt(dayStart(day)) !== offsetAt(dayStart(addDays(day, 1))))
  expect(changes).toHaveLength(2)
  for (const day of changes)
    for (const area of areas)
    {
      const whole = { from: dayStart(day), to: dayStart(addDays(day, 1)) + 12 * HOUR }
      const runs = segments(area, {}, whole, NONE)
      for (let at = whole.from; at < whole.to; at += HOUR / 4)
        expect(runs.find(run => run.from <= at && at < run.to)!.kind).toBe(stateAt(area, {}, at, NONE).kind)
    }
})

/** The next such weekday from tomorrow, outside the ban, so the cases never rot */
const next = (target: number) => {
  let day = addDays(today, 1)
  while (weekday(day) !== target || inWinterSeason(day))
    day = addDays(day, 1)
  return day
}
/** The coming 15 January, a weekday or not, deep in the ban */
const january = (day = 15): Day => {
  const date = `01-${String(day).padStart(2, "0")}`
  return `${+today.slice(0, 4) + (today.slice(5) >= date ? 1 : 0)}-${date}`
}
const byId = (id: string) => areas.find(area => area.id === id)!
const stay = (day: Day, from: string, hours: number): Stay => ({ from: atClock(day, from), to: atClock(day, from) + hours * HOUR })
const NONE: Day[] = []

test("Astra's reproductions, answered for the whole stay, and on a winter night only what's certain", () => {
  const tuesday = next(1)
  // B Lot, no permit, Tuesday 6:30 for two hours: permits are enforced from 7, before the car leaves
  const b = fits(byId("B"), {}, stay(tuesday, "06:30", 2), NONE)
  expect(b).toMatchObject({ fits: "no", why: "Permit required", from: atClock(tuesday, "07:00") })
  expect(b.segments.map(segment => segment.kind)).toEqual(["free", "closed"])
  expect(fits(byId("B"), {}, { from: atClock(tuesday, "06:30"), to: atClock(tuesday, "06:50") }, NONE).fits).toBe("yes")
  // D Lot and Edgewood, 15 January after midnight: the ban may apply, which isn't a yes
  const night = january()
  expect(fits(byId("D"), {}, stay(night, "23:30", 2), NONE)).toMatchObject({ fits: "unknown", why: "Winter ban may apply", from: atClock(addDays(night, 1), "00:00") })
  expect(fits(byId("edgewood"), {}, stay(night, "01:30", 2), NONE)).toMatchObject({ fits: "unknown", from: atClock(night, "01:30") })
  // E Lot on its own resident permit, 15 January at 3 AM: both UNH sources keep it open to its permit holders
  expect(fits(byId("E"), { permit: { resident: "E" } }, stay(night, "03:00", 2), NONE)).toMatchObject({ fits: "yes", why: "Your resident lot" })
  // Strafford, where the winter page and its grid disagree, isn't said to fit
  expect(fits(byId("strafford"), { permit: { resident: "strafford" } }, stay(night, "03:00", 2), NONE).fits).toBe("unknown")
  // A lot closed to you anyway is closed, winter or not: E Lot without its permit
  expect(fits(byId("E"), {}, stay(night, "03:00", 2), NONE).fits).toBe("no")
  // An evening before midnight, and a morning from 7, are ordinary
  expect(fits(byId("B"), {}, stay(january(), "19:00", 4), NONE).fits).toBe("yes")
  expect(fits(byId("A"), { permit: "commuter" }, stay(night, "07:00", 2), NONE).fits).toBe("yes")
  // The season counted is the widest any of UNH's pages gives, 1 December to 1 April
  expect(inWinterSeason(`${+january().slice(0, 4) - 1}-12-01`)).toBe(true)
  expect(inWinterSeason(`${+january().slice(0, 4) - 1}-11-30`)).toBe(false)
  expect(inWinterSeason(`${january().slice(0, 4)}-04-01`)).toBe(true)
  expect(inWinterSeason(`${january().slice(0, 4)}-04-02`)).toBe(false)
})

test("purpose, not time, refuses Thompson Hall, and an errand there may last an hour", () => {
  const tuesday = next(1)
  expect(fits(byId("t-hall"), { purpose: "class" }, stay(tuesday, "12:00", 1), NONE)).toMatchObject({ fits: "no", why: "Short errands only, not for class" })
  expect(fits(byId("t-hall"), {}, stay(tuesday, "12:00", 1), NONE).fits).toBe("no")
  expect(fits(byId("t-hall"), { purpose: "errand" }, stay(tuesday, "12:00", 0.5), NONE).fits).toBe("yes")
  expect(fits(byId("t-hall"), { purpose: "errand" }, stay(tuesday, "12:00", 2), NONE)).toMatchObject({ fits: "no", why: "Over the time limit", limit: 1, from: atClock(tuesday, "13:00") })
})

test("issue #17's people, for a stay", () => {
  const tuesday = next(1)
  const friday = next(4)
  const sunday = next(6)
  const commuter: Who = { permit: "commuter" }
  // A commuter's three-hour block at noon: A, not B, not E; Sage Way for money
  expect(fits(byId("A"), commuter, stay(tuesday, "12:00", 3), NONE)).toMatchObject({ fits: "yes", why: "Your permit" })
  expect(fits(byId("B"), commuter, stay(tuesday, "12:00", 3), NONE).fits).toBe("no")
  expect(fits(byId("E"), commuter, stay(tuesday, "12:00", 3), NONE).fits).toBe("no")
  expect(fits(byId("sage-way"), commuter, stay(tuesday, "12:00", 3), NONE)).toMatchObject({ fits: "yes", pay: 3, cost: 3 * 1.85 })
  // The same commuter Friday 8 to 11 PM: weekday lots are open, Sage Way charges until 9
  expect(fits(byId("B"), commuter, stay(friday, "20:00", 3), NONE)).toMatchObject({ fits: "yes", why: "Open to all outside weekday hours" })
  expect(fits(byId("sage-way"), commuter, stay(friday, "20:00", 3), NONE)).toMatchObject({ fits: "yes", why: "Pay", rate: 1.85, from: atClock(friday, "20:00"), pay: 1 })
  // A friend from Sunday noon to Monday noon: open lots refuse them at 7 Monday; Sage Way fits, paying twice
  expect(fits(byId("A"), {}, stay(sunday, "12:00", 24), NONE)).toMatchObject({ fits: "no", from: atClock(addDays(sunday, 1), "07:00") })
  expect(fits(byId("A"), {}, stay(sunday, "12:00", 18), NONE).fits).toBe("yes")
  const sage = fits(byId("sage-way"), {}, stay(sunday, "12:00", 24), NONE)
  expect(sage.fits).toBe("yes")
  expect(sage.segments.map(segment => segment.kind)).toEqual(["pay", "free", "pay"])
  // On a UNH holiday B opens to all and the meters are free
  expect(fits(byId("B"), {}, stay(tuesday, "12:00", 2), [tuesday])).toMatchObject({ fits: "yes", why: "Open to all: UNH holiday" })
  expect(fits(byId("academic-way-east"), {}, stay(tuesday, "12:00", 2), [tuesday]).pay).toBe(0)
})

test("segments name the moments the answer changes, so a row can say pay from 7 and free from 9", () => {
  const tuesday = next(1)
  const runs = segments(byId("sage-way"), {}, { from: atClock(tuesday, "05:00"), to: atClock(tuesday, "23:00") }, NONE)
  expect(runs.map(run => [run.kind, localMinutes(run.from)])).toEqual([["free", 300], ["pay", 420], ["free", 1260]])
  const open = segments(byId("B"), {}, { from: atClock(tuesday, "17:00"), to: atClock(tuesday, "19:00") }, NONE)
  expect(open.map(run => [run.kind, localMinutes(run.from)])).toEqual([["closed", 1020], ["free", 1080]])
})

/** A destination on campus: Kingsbury Hall's door, more or less */
const KINGSBURY = { lon: -70.9345, lat: 43.1336 }

test("options rank by whether the stay fits, then by the walk, and a guessed point is only an estimate and never starts a route", () =>
  fc.assert(fc.property(aWho, aStay, someHolidays, (who, stay, holidays) => {
    const starts: object[] = []
    const walks = { between: (from: { lon: number, lat: number }) => (starts.push(from), { meters: 100 + 1000 * Math.abs(from.lon - KINGSBURY.lon), coordinates: [], via: "network" as const }) }
    const ranked = options(areas, who, stay, holidays, { to: KINGSBURY, walks })
    expect(ranked).toHaveLength(areas.length)
    const RANK = { yes: 0, unknown: 1, no: 2 }
    for (let i = 1; i < ranked.length; i++) {
      expect(RANK[ranked[i].fits]).toBeGreaterThanOrEqual(RANK[ranked[i - 1].fits])
      if (ranked[i].fits === ranked[i - 1].fits)
        expect(ranked[i].walk!.meters).toBeGreaterThanOrEqual(ranked[i - 1].walk!.meters)
    }
    expect(starts).toHaveLength(areas.filter(area => !area.guessed).length)
    for (const option of ranked)
      expect(option.walk!.approx).toBe(!!option.area.guessed)
  }), { numRuns: 50 })
)

test("a guessed area has no start for a route, and without a walking network every walk is an estimate", () => {
  const guessed = areas.find(area => area.guessed)!
  expect(startOf(guessed)).toBeUndefined()
  expect(startOf(byId("B"))).toEqual({ lon: byId("B").at[0], lat: byId("B").at[1] })
  const walk = walkFrom(byId("B"), KINGSBURY)
  expect(walk.approx).toBe(false)
  expect(walk.meters).toBeGreaterThan(0)
  expect(walk.seconds).toBeGreaterThan(walk.meters / 2)
  // With nowhere to go, options still rank by fit, then by cost
  const ranked = options(areas, {}, stay(next(1), "12:00", 2), NONE)
  expect(ranked.every(option => option.walk === undefined)).toBe(true)
})
