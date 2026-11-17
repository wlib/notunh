// Days and rules as the recurrence tests make them: any day of six decades, never today, and rules composed as
// deep as curated.json and an imported calendar compose them

import fc from "fast-check"
import { type Rule, type Weekday, UNITS, WEEKDAYS, any, between, every, except, nth, on, weekly } from "../../src/shared/recur.mts"
import { Temporal } from "../../src/shared/temporal.mts"

const EPOCH = new Temporal.PlainDate(2000, 1, 1)

/** A day from 2000 through 2059 */
export const day = fc.integer({ min: 0, max: 60 * 365 }).map(days => EPOCH.add({ days }))

export const weekday: fc.Arbitrary<Weekday> = fc.constantFrom(...WEEKDAYS)

/** A day within some days of another, either side */
export const near = (base: Temporal.PlainDate, within: number) =>
  fc.integer({ min: -within, max: within }).map(days => base.add({ days }).toString())

/** A rule one RRULE can say: weekly days, an nth weekday or day of the month */
export const simple: fc.Arbitrary<Rule> = fc.oneof(
  fc.uniqueArray(weekday, { minLength: 1 }).map(days => weekly(...days)),
  fc.tuple(fc.constantFrom(-5, -4, -3, -2, -1, 1, 2, 3, 4, 5), weekday).map(([k, name]) => nth(k, name)),
  fc.integer({ min: -31, max: 31 }).filter(k => k !== 0).map(k => nth(k))
)

/** A rule composed of others about a day: every nth, between days, any of some, one but another, days named */
export const ruleNear = (base: Temporal.PlainDate, within = 200): fc.Arbitrary<Rule> =>
  fc.letrec<{ rule: Rule }>(tie => ({
    rule: fc.oneof(
      { maxDepth: 3 },
      simple,
      fc.array(near(base, within), { maxLength: 5 }).map(days => on(...days)),
      fc.tuple(fc.integer({ min: 1, max: 5 }), tie("rule"), near(base, within), fc.constantFrom(...UNITS)).map(([n, of, from, unit]) => every(n, of, from, unit)),
      fc.tuple(near(base, within), fc.integer({ min: 0, max: within }), tie("rule")).map(([from, length, of]) => between(from, Temporal.PlainDate.from(from).add({ days: length }).toString(), of)),
      fc.array(tie("rule"), { maxLength: 3 }).map(rules => any(...rules)),
      fc.tuple(tie("rule"), tie("rule")).map(([of, but]) => except(of, but))
    )
  })).rule

/** A day, and a rule composed about it */
export const dayAndRule = day.chain(base => ruleNear(base).map(rule => ({ base, rule })))

/** A time of day to the minute, "HH:MM" */
export const clock = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([hours, minutes]) => `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`)
