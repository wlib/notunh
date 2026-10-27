// Whether a stay fits a parking area, as a pure function of the area's rules, who is parking, the stay, and UNH's
// holidays. It answers for the whole stay rather than the moment of arrival, because a car parked at 6:30 is still
// there when permits are enforced at 7. The rules are kept by hand (areas.mts) and checked each night against the
// sources a machine can read (sources.mts, scripts/map/parking.mts).
//
// Three facts are kept apart because they're different facts: whether the stay fits (eligibility), when it costs
// money (payment), and whether the rules can be known at all (confidence).
//
// Winter is the one that can't be. UNH's winter parking ban closes most lots from midnight to 6, daytime rules
// resuming at 7, on nights from 1 January to 1 April, which can change by announcement; one paragraph of the visitor
// page says from 1 December; which lots stay open differs between the winter page and its own grid of lots, and
// again on a declared snow emergency, declared by phone each night. So from 1 December to 1 April, midnight to 7,
// nothing here claims an area is open: it says the ban may apply, and the page links to UNH's. Only what's certain
// either way is said: a lot closed then by its ordinary rules is closed, and a resident lot both lists keep open to
// its permit holders all night is theirs

import * as v from "valibot"
import type { Point } from "../geo/projection.mts"
import { type Walks, estimatedMeters, walkSeconds } from "../routing/walks.mts"
import { type Day, DAY, HOUR, addDays, dayStart, localDay, localMinutes, weekday } from "../shared/time.mts"

/** What a permit lets you into: the map key's kinds, and a resident permit, which is for one lot */
export const Permit = v.union([
  v.picklist(["commuter", "faculty", "resident-west", "non-resident"]),
  v.object({ resident: v.string() })
])
export type Permit = v.InferOutput<typeof Permit>

/** A paid window: the weekdays (0 Monday to 6 Sunday), the minutes of the day it covers, the rate, and the hours one payment may cover */
export const Paid = v.object({
  days:  v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6))),
  hours: v.tuple([v.number(), v.number()]),
  rate:  v.number(),
  max:   v.number()
})
export type Paid = v.InferOutput<typeof Paid>

export const Zone = v.object({
  /** The ParkMobile number on the sign, like 98717 */
  number: v.number(),
  paid:   v.array(Paid)
})
export type Zone = v.InferOutput<typeof Zone>

/** The smallest area with a rule of its own: a lot, its meter spaces, or A Lot's rear sections */
export const Area = v.object({
  id:        v.string(),
  name:      v.string(),
  /** Who may park on a permit, at any hour; empty for a pay-only or town area */
  permits:   v.array(Permit),
  /** Whether permits are checked around the clock (resident and mixed-with-resident lots) or weekdays 7 to 6 */
  always:    v.boolean(),
  zone:      v.optional(Zone),
  /** Whether its permit holders may stay all night through the winter ban, as UNH's winter page and its grid both say */
  winter:    v.optional(v.literal("permit-holders")),
  /** A rule that isn't about time: Thompson Hall's lot is for short errands, not for class */
  purpose:   v.optional(v.picklist(["errands"])),
  /** OpenStreetMap ways and relations drawing it, like "way/27805292", for the tiles' outlines */
  osm:       v.array(v.string()),
  /** Its middle as lon, lat: OpenStreetMap's outline's, ParkMobile's display point, or a guess */
  at:        v.tuple([v.number(), v.number()]),
  /** How many spaces OpenStreetMap's outline says it has, where it says */
  spaces:    v.optional(v.number()),
  /** Whether `at` was placed by eye beside a building rather than read from a source, so no route starts there */
  guessed:   v.optional(v.boolean()),
  notes:     v.optional(v.string())
})
export type Area = v.InferOutput<typeof Area>

/** Why someone is parking, where an area cares */
export type Purpose = "class" | "errand" | "event" | "visit"

/** A person at the wheel: their permit, if any, and why they're here, if they said */
export type Who = { permit?: Permit, purpose?: Purpose }

/** A stay: arrival and departure as instants, departure after arrival */
export type Stay = { from: number, to: number }

/**
 * What an area is to someone at an instant: free, pay (at a rate in dollars an hour, for at most so many hours),
 * theirs by permit, closed to them, or not knowable, as on a winter night
 */
export type State =
  | { kind: "free" | "permit" | "closed" | "unknown", why: string }
  | { kind: "pay", why: string, rate: number, max: number }
export type Kind = State["kind"]

/** A run of one state over part of a stay */
export type Segment = State & { from: number, to: number }

/**
 * A verdict in brief: whether it fits, why, and from when, and for paying, the rate in dollars an hour, or for a stay
 * too long, the hours it may last. The why names no number, which the page formats: a row says "from 7 AM" where
 * that's later than the arrival, "Pay $1.85/h", or "Over the 2 hr limit"
 */
export type Answer = { fits: "yes" | "no" | "unknown", why: string, from: number, rate?: number, limit?: number }

/**
 * The answer for a whole stay: whether it fits, why, and from when that reason holds (the arrival, or the instant it
 * bites, so a row can say "permit holders only from 7 AM"); the segments it's made of; the hours that cost money and
 * what they cost
 */
export type Verdict = Answer & { segments: Segment[], pay: number, cost: number }

export const WEEKDAYS = [0, 1, 2, 3, 4]
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const ENFORCED: [number, number] = [7 * 60, 18 * 60]

/** Every minute of the day a rule here names, besides the paid windows' own */
const CLOCKS = [0, 60, 2 * 60, 6 * 60, 7 * 60, 18 * 60]

const samePermit = (a: Permit, b: Permit) =>
  typeof a === "string" ? a === b : typeof b === "object" && a.resident === b.resident

/** Whether someone's permit is one an area takes */
export const holds = (area: Area, permit: Permit | undefined) =>
  permit !== undefined && area.permits.some(each => samePermit(each, permit))

/** Whether a Durham day's early hours may be under the winter parking ban: 1 December to 1 April, both included */
export const inWinterSeason = (day: Day) =>
  /^\d{4}-(12-|01-|02-|03-|04-01)/.test(day)

/** Until when on a winter morning the ban may apply: 7, when UNH's daytime rules resume */
const WINTER_UNTIL = 7 * 60

/** Whether a paid window covers a minute of a day */
const covers = (paid: Paid, day: Day, minutes: number) =>
  paid.days.includes(weekday(day)) && paid.hours[0] <= minutes && minutes < paid.hours[1]

/** The ordinary rules' say at a minute of a day, winter aside */
const ordinary = (area: Area, who: Who, day: Day, minutes: number, holidays: readonly Day[]): State => {
  // UNH's holidays suspend its permit checks and free its meters
  const holiday = holidays.includes(day)
  if (holds(area, who.permit))
    return { kind: "permit", why: typeof who.permit === "object" ? "Your resident lot" : "Your permit" }
  if (area.zone) {
    const paid = area.zone.paid.find(paid => covers(paid, day, minutes))
    if (!paid || holiday)
      return { kind: "free", why: holiday ? "Free: UNH holiday" : "Free outside paid hours" }
    return { kind: "pay", why: "Pay", rate: paid.rate, max: paid.max }
  }
  if (!area.permits.length)
    return { kind: "closed", why: area.notes ?? "Not for parking" }
  if (area.always)
    return { kind: "closed", why: "Permit holders only" }
  const enforced = !holiday && WEEKDAYS.includes(weekday(day)) && ENFORCED[0] <= minutes && minutes < ENFORCED[1]
  return enforced
    ? { kind: "closed", why: "Permit required" }
    : { kind: "free", why: holiday ? "Open to all: UNH holiday" : "Open to all outside weekday hours" }
}

/**
 * What an area is to someone at an instant: its ordinary rules, except early on a winter morning, when what's
 * certain is said, closed by those rules or a permit holder's all night, and otherwise that the ban may apply
 */
export const stateAt = (area: Area, who: Who, at: number, holidays: readonly Day[]): State => {
  const day = localDay(at)
  const minutes = localMinutes(at)
  const base = ordinary(area, who, day, minutes, holidays)
  if (!inWinterSeason(day) || minutes >= WINTER_UNTIL || base.kind === "closed" || (base.kind === "permit" && area.winter === "permit-holders"))
    return base
  return { kind: "unknown", why: "Winter ban may apply" }
}

/**
 * The instants in a stay at which the rules might change: every minute of the day any rule names, on each day the
 * stay touches. Each is taken at the day's midnight offset and an hour either side, so a boundary on a day the clocks
 * change is among them; cuts where nothing changes are joined again
 */
const boundaries = (area: Area, stay: Stay) => {
  const clocks = new Set([...CLOCKS, ...(area.zone?.paid.flatMap(paid => paid.hours) ?? [])])
  const cuts = new Set<number>()
  for (let day = localDay(stay.from); dayStart(day) <= stay.to; day = addDays(day, 1))
    for (const minutes of clocks)
      for (const shift of [-HOUR, 0, HOUR]) {
        const at = dayStart(day) + minutes * 60_000 + shift
        if (stay.from < at && at < stay.to)
          cuts.add(at)
      }
  return [...cuts].sort((a, b) => a - b)
}

const sameState = (a: State, b: State) =>
  a.kind === b.kind && a.why === b.why

/** The stay as runs of one state each, in order, adjacent alike runs joined */
export const segments = (area: Area, who: Who, stay: Stay, holidays: readonly Day[]): Segment[] => {
  const cuts = [stay.from, ...boundaries(area, stay), stay.to]
  const runs: Segment[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const state = stateAt(area, who, cuts[i], holidays)
    const last = runs.at(-1)
    if (last && sameState(last, state))
      last.to = cuts[i + 1]
    else
      runs.push({ ...state, from: cuts[i], to: cuts[i + 1] })
  }
  return runs
}

/** Runs of paid segments back to back: what one payment has to cover, since parking unpaid between them is free */
export const paidStretches = (runs: readonly Segment[]) =>
  runs.reduce<{ from: number, to: number, max: number }[]>((stretches, run) => {
    if (run.kind !== "pay")
      return stretches
    const last = stretches.at(-1)
    if (last && last.to === run.from) {
      last.to = run.to
      last.max = Math.min(last.max, run.max)
    }
    else
      stretches.push({ from: run.from, to: run.to, max: run.max })
    return stretches
  }, [])

/**
 * Whether the whole stay fits: the purpose allowed, no run of it closed, no paid stretch longer than one payment may
 * cover, and none unknowable, as a winter night is. Each failure says from when it bites
 */
export const fits = (area: Area, who: Who, stay: Stay, holidays: readonly Day[]): Verdict =>
  judge(area, who, stay, segments(area, who, stay, holidays))

/** The verdict a stay's segments make */
const judge = (area: Area, who: Who, stay: Stay, runs: Segment[]): Verdict => {
  const paid = runs.filter(run => run.kind === "pay")
  const pay = paid.reduce((sum, run) => sum + (run.to - run.from), 0) / HOUR
  const cost = paid.reduce((sum, run) => sum + (run.to - run.from) / HOUR * run.rate, 0)
  const verdict = (fits: Verdict["fits"], why: string, from: number, more?: Pick<Answer, "rate" | "limit">): Verdict =>
    ({ fits, why, from, ...more, segments: runs, pay, cost })
  if (area.purpose === "errands" && who.purpose !== "errand")
    return verdict("no", who.purpose ? `Short errands only, not for ${who.purpose === "class" ? "class" : `${who.purpose}s`}` : "Short errands only", stay.from)
  const closed = runs.find(run => run.kind === "closed")
  if (closed)
    return verdict("no", closed.why, closed.from)
  const over = paidStretches(runs).find(stretch => stretch.to - stretch.from > stretch.max * HOUR)
  if (over)
    return verdict("no", "Over the time limit", over.from + over.max * HOUR, { limit: over.max })
  const unknown = runs.find(run => run.kind === "unknown")
  if (unknown)
    return verdict("unknown", unknown.why, unknown.from)
  const first = paid[0]
  return first
    ? verdict("yes", "Pay", first.from, { rate: first.rate })
    : verdict("yes", runs[0].why, stay.from)
}

/** The first change of what an area is to someone after an instant, within a week, as "open from 6 PM" says it */
export const nextChange = (area: Area, who: Who, at: number, holidays: readonly Day[]): Segment | undefined =>
  segments(area, who, { from: at, to: at + 7 * DAY }, holidays)[1]

/** How far an area is walked from, to a destination, and whether that's only roughly so, its point being a guess */
export type Walk = { meters: number, seconds: number, approx: boolean }

/** An area's verdict for a stay, and its walk to the destination if one was given */
export type Option = Verdict & { area: Area, walk?: Walk }

/** Where a route may start from an area: its point, unless that's a guess */
export const startOf = (area: Area): Point | undefined =>
  area.guessed ? undefined : { lon: area.at[0], lat: area.at[1] }

/**
 * The walk from an area to a destination: along the walking network when given one, else, or from a guessed point,
 * a straight line's estimate.
 * TODO: walk from the area's entrances once OpenStreetMap draws them, rather than from its middle
 */
export const walkFrom = (area: Area, to: Point, walks?: Pick<Walks, "between">): Walk => {
  const start = startOf(area)
  const from = { lon: area.at[0], lat: area.at[1] }
  const walked = start && walks ? walks.between(start, to) : { meters: estimatedMeters(from, to), via: "estimate" }
  return { meters: walked.meters, seconds: walkSeconds(walked.meters), approx: !start }
}

const RANK = { yes: 0, unknown: 1, no: 2 }

/**
 * Areas for a stay and a person, best first: by whether the stay fits (yes, unknown, no), then by the walk to the
 * destination if one is given, then by what it costs. Ranked, not chosen: the person picks
 */
export const options = (areas: readonly Area[], who: Who, stay: Stay, holidays: readonly Day[], near?: { to: Point, walks?: Pick<Walks, "between"> }): Option[] =>
  areas
    .map(area => ({ area, ...fits(area, who, stay, holidays), walk: near && walkFrom(area, near.to, near.walks) }))
    .sort((a, b) => RANK[a.fits] - RANK[b.fits] || (a.walk && b.walk ? a.walk.meters - b.walk.meters : 0) || a.cost - b.cost)

/**
 * ParkMobile, where a zone's number is entered to pay: its web app's front page, as the zone links it has aren't
 * documented and one tried opened the front page anyway. The page names the zone beside it. The payment is never ours
 */
export const PARKMOBILE_APP = "https://app.parkmobile.io/"
