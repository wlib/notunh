// When something happens again: a rule is a set of days, made of a few rules that compose, the same shape in JSON
// (curated.json) and in code. weekly("Tue", "Thu") is every Tuesday and Thursday; nth(1, "Tue") the first Tuesday of
// each month, nth(-1, "Fri") the last Friday, nth(15) the 15th; on(...) the days named; any(...) the days of any of
// its rules; except(a, b) a's days but b's; between(from, until, rule) a rule's days from one day to another; and
// every(2, rule, anchor) a rule's days in every other week, counted from the week its anchor is in, or every so many
// days or months. Every curated series, class meeting, club meeting, Campus Rec booking and imported event is one
// (src/social/curated.mts, src/courses/course.mts, src/courses/rec.mts, ics.mts), and occurs is the one evaluator
//
// A session is a rule with a time of day it starts and ends at: days and times apart, so a class at 1:30 is at 1:30
// on the clock whatever the clocks did that morning. Days are Temporal's PlainDate, weeks start on Monday, and a
// moment is only made once a zone is named (spanOn). Pure

import * as v from "valibot"
import { Temporal, instantAt } from "./temporal.mts"
import { Day, TIME_ZONE } from "./time.mts"

/** The weekdays as they're kept and shown, Monday first */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
export type Weekday = typeof WEEKDAYS[number]

/** What every counts by: weeks from Monday unless said */
export const UNITS = ["day", "week", "month"] as const
export type Unit = typeof UNITS[number]

export type Rule =
  | { weekly: readonly Weekday[] }
  | { nth: number, weekday?: Weekday }
  | { on: readonly Day[] }
  | { any: readonly Rule[] }
  | { of: Rule, except: Rule }
  | { of: Rule, between: readonly [from: Day, until?: Day] }
  | { of: Rule, every: number, from: Day, unit?: Unit }

const Weekday = v.picklist(WEEKDAYS)

export const Rule: v.GenericSchema<Rule> = v.lazy(() => v.union([
  v.strictObject({ weekly: v.array(Weekday) }),
  v.pipe(
    v.strictObject({ nth: v.pipe(v.number(), v.integer(), v.notValue(0), v.minValue(-31), v.maxValue(31)), weekday: v.optional(Weekday) }),
    v.check(({ nth, weekday }) => !weekday || Math.abs(nth) <= 5, "A month has at most five of a weekday")
  ),
  v.strictObject({ on: v.array(Day) }),
  v.strictObject({ any: v.array(Rule) }),
  v.strictObject({ of: Rule, except: Rule }),
  v.strictObject({ of: Rule, between: v.union([v.strictTuple([Day]), v.strictTuple([Day, Day])]) }),
  v.strictObject({ of: Rule, every: v.pipe(v.number(), v.integer(), v.minValue(1)), from: Day, unit: v.optional(v.picklist(UNITS)) })
]))

//#region The rules

/** Every week on these weekdays */
export const weekly = (...days: Weekday[]): Rule =>
  ({ weekly: days })

/** Every day */
export const daily = weekly(...WEEKDAYS)

/** The kth of a weekday in each month, or the kth day of each month; from its end where k is negative, -1 the last */
export const nth = (k: number, weekday?: Weekday): Rule =>
  weekday ? { nth: k, weekday } : { nth: k }

/** The days named */
export const on = (...days: Day[]): Rule =>
  ({ on: days })

/** The days of any of some rules */
export const any = (...rules: Rule[]): Rule =>
  ({ any: rules })

/** A rule's days, but another's */
export const except = (of: Rule, but: Rule): Rule =>
  ({ of, except: but })

/** A rule's days from a day until another, both included, or from a day on */
export const between = (from: Day, until: Day | undefined, of: Rule): Rule =>
  ({ of, between: until === undefined ? [from] : [from, until] })

/** A rule's days in every nth week, counted from the week a day is in; or in every nth day or month, from that day's */
export const every = (n: number, of: Rule, from: Day, unit: Unit = "week"): Rule =>
  ({ of, every: n, from, ...unit !== "week" && { unit } })

//#endregion

/** A day as rules are asked about it: itself, as text, which compares as days do, and its weekday */
type At = { day: Temporal.PlainDate, iso: Day, weekday: Weekday }

const isNth = ({ nth: k, weekday }: { nth: number, weekday?: Weekday }, { day, weekday: its }: At) => {
  if (weekday && weekday !== its)
    return false
  const fromStart = day.day
  const fromEnd = day.daysInMonth - day.day + 1
  return weekday
    ? (k > 0 ? Math.ceil(fromStart / 7) === k : Math.ceil(fromEnd / 7) === -k)
    : (k > 0 ? fromStart === k : fromEnd === -k)
}

/** Whether a day's day, week or month is a whole number of every's cycles from its anchor's, before it or after */
const isInCycle = ({ every: n, from, unit = "week" }: { every: number, from: Day, unit?: Unit }, { day }: At) => {
  const anchor = Temporal.PlainDate.from(from)
  const apart =
    unit === "month" ? (day.year - anchor.year) * 12 + day.month - anchor.month :
    unit === "day"   ? anchor.until(day).days :
    Math.floor((anchor.until(day).days + anchor.dayOfWeek - 1) / 7)
  return apart % n === 0
}

const holds = (rule: Rule, at: At): boolean =>
  "weekly"  in rule ? rule.weekly.includes(at.weekday) :
  "nth"     in rule ? isNth(rule, at) :
  "on"      in rule ? rule.on.includes(at.iso) :
  "any"     in rule ? rule.any.some(one => holds(one, at)) :
  "except"  in rule ? holds(rule.of, at) && !holds(rule.except, at) :
  "between" in rule ? rule.between[0] <= at.iso && (rule.between[1] === undefined || at.iso <= rule.between[1]) && holds(rule.of, at) :
  isInCycle(rule, at) && holds(rule.of, at)

/** Asks rules about one day, which is read once however many are asked, as a day's classes ask thousands */
export const occursOn = (day: Temporal.PlainDate) => {
  const at: At = { day, iso: day.toString(), weekday: WEEKDAYS[day.dayOfWeek - 1] }
  return (rule: Rule) => holds(rule, at)
}

/** Whether a rule falls on a day */
export const occurs = (rule: Rule, day: Temporal.PlainDate) =>
  occursOn(day)(rule)

/** The days a rule falls on among some days from one, in order */
export const occurrences = (rule: Rule, from: Temporal.PlainDate, days: number) => {
  const found: Temporal.PlainDate[] = []
  for (let i = 0, day = from; i < days; i++, day = day.add({ days: 1 }))
    if (occurs(rule, day))
      found.push(day)
  return found
}

/** The bounds of a rule that never falls: a first day after its last */
const NEVER = { from: "9999-12-31", until: "0001-01-01" }

/**
 * The first and last days a rule can fall on, where it says: between's, the days on names, the widest of any's.
 * A rule that never falls has a first day after its last
 */
export const boundsOf = (rule: Rule): { from?: Day, until?: Day } => {
  if ("weekly" in rule || "nth" in rule)
    return {}
  if ("on" in rule) {
    const days = [...rule.on].sort()
    return days.length ? { from: days[0], until: days.at(-1) } : NEVER
  }
  if ("any" in rule) {
    const all = rule.any.map(boundsOf).filter(({ from, until }) => from === undefined || until === undefined || from <= until)
    return all.length === 0 ? NEVER : {
      from:  all.some(({ from }) => from === undefined) ? undefined : all.map(({ from }) => from!).sort()[0],
      until: all.some(({ until }) => until === undefined) ? undefined : all.map(({ until }) => until!).sort().at(-1)
    }
  }
  const inner = boundsOf(rule.of)
  if (!("between" in rule))
    return inner
  const [from, until] = rule.between
  return {
    from:  inner.from === undefined || inner.from < from ? from : inner.from,
    until: inner.until === undefined || (until !== undefined && until < inner.until) ? until : inner.until
  }
}

//#region Sessions

/** A time of day, "HH:MM", on a 24-hour clock */
export const Clock = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/))

/**
 * When something is on, again and again: the days, the time of day it starts and the time it ends, by the clock of
 * wherever it is; and the nights it runs through, where it ends on a later day than it starts
 */
export const Session = v.object({
  rule:   Rule,
  start:  Clock,
  end:    Clock,
  nights: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))
})
export type Session = v.InferOutput<typeof Session>

/** A session on a day, from its start to its end in epoch ms, by a zone's clock */
export const spanOn = ({ start, end, nights = 0 }: Pick<Session, "start" | "end" | "nights">, day: Temporal.PlainDate, zone = TIME_ZONE) =>
  ({ start: instantAt(day, start, zone), end: instantAt(nights ? day.add({ days: nights }) : day, end, zone) })

/** A session's occurrences starting on some days from one, in order: each its day, start and end */
export const spansOf = (session: Session, from: Temporal.PlainDate, days: number, zone = TIME_ZONE) =>
  occurrences(session.rule, from, days).map(day => ({ day, ...spanOn(session, day, zone) }))

//#endregion
