import { test, expect } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { Rule, UNITS, WEEKDAYS, any, between, boundsOf, daily, every, except, nth, occurrences, occurs, on, spanOn, spansOf, weekly } from "../../src/shared/recur.mts"
import { Temporal, dayAt } from "../../src/shared/temporal.mts"
import { HOUR, TIME_ZONE, hhmm } from "../../src/shared/time.mts"
import { clock, day, dayAndRule, near, ruleNear, weekday } from "./rules.mts"

/** A day, two rules about it, and a day near it to ask them about */
const asked = day.chain(base => fc.record({ a: ruleNear(base), b: ruleNear(base), c: ruleNear(base), at: near(base, 400).map(Temporal.PlainDate.from) }))

test("a rule but itself never falls, and a rule but one that never falls is itself", () =>
  fc.assert(fc.property(asked, ({ a, at }) => {
    expect(occurs(except(a, a), at)).toBe(false)
    expect(occurs(except(a, on()), at)).toBe(occurs(a, at))
    expect(occurs(except(a, any()), at)).toBe(occurs(a, at))
  })))

test("any is commutative, idempotent and associative, and any of none never falls", () =>
  fc.assert(fc.property(asked, ({ a, b, c, at }) => {
    expect(occurs(any(a, b), at)).toBe(occurs(any(b, a), at))
    expect(occurs(any(a, a), at)).toBe(occurs(a, at))
    expect(occurs(any(a, any(b, c)), at)).toBe(occurs(any(any(a, b), c), at))
    expect(occurs(any(a, b, c), at)).toBe(occurs(a, at) || occurs(b, at) || occurs(c, at))
    expect(occurs(any(), at)).toBe(false)
  })))

test("except takes away what any adds: a but b or c is a but b, but c", () =>
  fc.assert(fc.property(asked, ({ a, b, c, at }) => {
    expect(occurs(except(a, any(b, c)), at)).toBe(occurs(except(except(a, b), c), at))
    expect(occurs(except(any(a, b), b), at)).toBe(occurs(except(a, b), at))
  })))

test("every one of a rule's weeks, days or months is the rule, whatever the anchor", () =>
  fc.assert(fc.property(asked, fc.constantFrom(...UNITS), fc.integer({ min: -400, max: 400 }), ({ a, at }, unit, apart) => {
    expect(occurs(every(1, a, at.add({ days: apart }).toString(), unit), at)).toBe(occurs(a, at))
  })))

test("between restricts a rule to its days, both ends included, and one with no last day runs on", () =>
  fc.assert(fc.property(asked, fc.integer({ min: -100, max: 100 }), fc.integer({ min: 0, max: 100 }), ({ a, at }, before, length) => {
    const from = at.add({ days: before })
    const until = from.add({ days: length })
    const within = Temporal.PlainDate.compare(from, at) <= 0 && Temporal.PlainDate.compare(at, until) <= 0
    expect(occurs(between(from.toString(), until.toString(), a), at)).toBe(within && occurs(a, at))
    expect(occurs(between(from.toString(), undefined, a), at)).toBe(Temporal.PlainDate.compare(from, at) <= 0 && occurs(a, at))
    expect(occurs(between(at.toString(), at.toString(), a), at)).toBe(occurs(a, at))
  })))

test("every nth week of a weekday is that weekday n weeks apart, its anchor's week among them, and the n phases share its weeks out", () =>
  fc.assert(fc.property(day, weekday, fc.integer({ min: 1, max: 6 }), (anchor, name, n) => {
    const from = anchor.subtract({ days: 200 })
    const found = occurrences(every(n, weekly(name), anchor.toString()), from, 400)
    for (const [i, one] of found.entries()) {
      expect(WEEKDAYS[one.dayOfWeek - 1]).toBe(name)
      if (i)
        expect(found[i - 1].until(one).days).toBe(7 * n)
    }
    // The one in the anchor's own week, which starts on Monday
    const monday = anchor.subtract({ days: anchor.dayOfWeek - 1 })
    expect(found.some(one => monday.until(one).days >= 0 && monday.until(one).days < 7)).toBe(true)
    const phases = Array.from({ length: n }, (_, k) => occurrences(every(n, weekly(name), anchor.add({ weeks: k }).toString()), from, 400).map(String))
    expect(phases.flat().sort()).toEqual(occurrences(weekly(name), from, 400).map(String))
  })))

test("every nth day and month count from the anchor's own, before it and after", () =>
  fc.assert(fc.property(day, fc.integer({ min: 1, max: 9 }), fc.integer({ min: -500, max: 500 }), (anchor, n, apart) => {
    const at = anchor.add({ days: apart })
    expect(occurs(every(n, daily, anchor.toString(), "day"), at)).toBe(apart % n === 0)
    const months = (at.year - anchor.year) * 12 + at.month - anchor.month
    expect(occurs(every(n, daily, anchor.toString(), "month"), at)).toBe(months % n === 0)
  })))

test("the nth of a weekday is once a month where the month has one, the last is within its last week, and the nth day counts from either end", () =>
  fc.assert(fc.property(day, weekday, fc.constantFrom(-4, -3, -2, -1, 1, 2, 3, 4), (at, name, k) => {
    const first = at.with({ day: 1 })
    const month = occurrences(nth(k, name), first, first.daysInMonth)
    expect(month).toHaveLength(1)
    const all = occurrences(weekly(name), first, first.daysInMonth).map(String)
    expect(month[0].toString()).toBe(all.at(k > 0 ? k - 1 : k))
    expect(occurrences(nth(-1, name), first, first.daysInMonth)[0].add({ days: 7 }).month).not.toBe(first.month)
    expect(occurs(nth(at.day), at)).toBe(true)
    expect(occurs(nth(at.day - at.daysInMonth - 1), at)).toBe(true)
    expect(occurrences(any(nth(at.day), nth(-1)), first, first.daysInMonth).length).toBeLessThanOrEqual(2)
  })))

test("a rule's days are those it falls on, in order, each within the first and last days it says it can", () =>
  fc.assert(fc.property(dayAndRule, fc.integer({ min: 0, max: 500 }), ({ base, rule }, days) => {
    const from = base.subtract({ days: 250 })
    const found = occurrences(rule, from, days)
    expect(found.map(String)).toEqual(Array.from({ length: days }, (_, i) => from.add({ days: i })).filter(one => occurs(rule, one)).map(String))
    const { from: first, until: last } = boundsOf(rule)
    for (const one of found) {
      expect(first === undefined || first <= one.toString()).toBe(true)
      expect(last === undefined || one.toString() <= last).toBe(true)
    }
  })))

test("a rule is the same shape in JSON as in code: what's written reads back as itself, and falls on the same days", () =>
  fc.assert(fc.property(dayAndRule, ({ base, rule }) => {
    const read = v.parse(Rule, JSON.parse(JSON.stringify(rule)))
    expect(read).toEqual(rule)
    expect(occurrences(read, base.subtract({ days: 100 }), 200).map(String)).toEqual(occurrences(rule, base.subtract({ days: 100 }), 200).map(String))
  })))

test("a rule of a shape no rule has isn't one", () => {
  for (const not of [{}, { weekly: ["Mo"] }, { nth: 0 }, { nth: 6, weekday: "Mon" }, { on: ["2026-02-30x"] }, { of: { weekly: [] }, every: 0, from: "2026-01-01" }, { of: { weekly: [] } }, { weekly: [], on: [] }, { of: { weekly: [] }, between: [] }])
    expect(v.safeParse(Rule, not).success).toBe(false)
})

//#region Sessions and the clocks' changes

/** The day the clocks change in a year: the second Sunday of March, the first of November */
const changes = fc.integer({ min: 2008, max: 2059 }).map(year => ({
  spring: occurrences(nth(2, "Sun"), new Temporal.PlainDate(year, 3, 1), 31)[0],
  autumn: occurrences(nth(1, "Sun"), new Temporal.PlainDate(year, 11, 1), 30)[0]
}))

test("a weekly session is at its time on Durham's clock every week of the year, across both changes of the clocks", () =>
  fc.assert(fc.property(changes, clock, fc.integer({ min: 1, max: 600 }), ({ spring }, start, length) => {
    const first = spring.subtract({ weeks: 8 })
    const end = Temporal.PlainTime.from(start).add({ minutes: length })
    // Any times but those the clocks skip that morning
    fc.pre([start, end.toString()].every(time => time < "02:00" || time >= "03:00"))
    const session = { rule: weekly("Sun"), start, end: end.toString({ smallestUnit: "minute" }), ...end.toString() < start && { nights: 1 } }
    const spans = spansOf(session, first, 52 * 7)
    expect(spans).toHaveLength(52)
    for (const span of spans) {
      expect(dayAt(span.start).toString()).toBe(span.day.toString())
      expect(hhmm(span.start)).toBe(start)
      expect(hhmm(span.end)).toBe(session.end)
      expect(span.end).toBeGreaterThan(span.start)
    }
  })))

test("a 1:30 AM session the night the clocks fall back is the first 1:30, an hour longer by the clock's repeat; in spring a time skipped is an hour on", () =>
  fc.assert(fc.property(changes, ({ spring, autumn }) => {
    const session = { rule: weekly("Sun"), start: "01:30", end: "02:30" }
    const [before, falls, after] = spansOf(session, autumn.subtract({ weeks: 1 }), 21)
    expect([before, falls, after].map(({ start }) => hhmm(start))).toEqual(["01:30", "01:30", "01:30"])
    expect(falls.start - before.start).toBe(7 * 24 * HOUR)
    expect(after.start - falls.start).toBe(7 * 24 * HOUR + HOUR)
    expect([before, falls, after].map(({ start, end }) => (end - start) / HOUR)).toEqual([1, 2, 1])
    // The second 1:30 that night is an hour after the session starts
    expect(Temporal.Instant.fromEpochMilliseconds(falls.start + HOUR).toZonedDateTimeISO(TIME_ZONE).toPlainTime().toString({ smallestUnit: "minute" })).toBe("01:30")
    const skipped = spanOn({ start: "02:30", end: "03:30" }, spring)
    expect(hhmm(skipped.start)).toBe("03:30")
    expect(skipped.start - spanOn({ start: "01:30", end: "01:45" }, spring).start).toBe(HOUR)
  })))

test("a session through the night ends that many days on, and its days are its rule's", () =>
  fc.assert(fc.property(dayAndRule, clock, clock, fc.integer({ min: 1, max: 3 }), ({ base, rule }, start, end, nights) => {
    const spans = spansOf({ rule, start, end, nights }, base.subtract({ days: 60 }), 120)
    expect(spans.map(({ day }) => String(day))).toEqual(occurrences(rule, base.subtract({ days: 60 }), 120).map(String))
    for (const span of spans)
      expect(dayAt(span.end).toString()).toBe(dayAt(span.start).add({ days: nights }).toString())
  })))

//#endregion
