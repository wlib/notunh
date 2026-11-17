import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { Curated, type Series, entriesOf, fromCurated, slugIn, slugOf } from "../../src/social/curated.mts"
import type { Event } from "../../src/social/event.mts"
import { readEvents, writeCalendar } from "../../src/shared/ics.mts"
import { type Rule, WEEKDAYS, between, boundsOf, occurrences, on, spansOf, weekly } from "../../src/shared/recur.mts"
import { instantAt, plainDay } from "../../src/shared/temporal.mts"
import { type Day, addDays, atClock, daysBetween, localDay, weekday as weekdayOf } from "../../src/shared/time.mts"
import { day, ruleNear, weekday } from "../shared/rules.mts"

const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const match = placeMatcher(gazetteer.places.map(place => place.name))

const kept = v.parse(Curated, JSON.parse(await readFile(new URL("../../src/social/curated.json", import.meta.url), "utf8")))

/** A series of one session, at an hour */
const seriesOn = (rule: Rule, hour: number, checked: Day): Series => ({
  title: "Russian Conversation Hour", where: "Murkland G10 Lounge", sessions: [{ rule, start: `${String(hour).padStart(2, "0")}:00`, end: `${String(hour + 1).padStart(2, "0")}:00` }],
  url: "https://cola.unh.edu/x", passage: "2-3pm every Friday", checked
})

/** A day, weekdays, and a first and last day about it */
const weekdays = fc.record({
  today:  day.map(String),
  days:   fc.uniqueArray(weekday, { minLength: 1, maxLength: 7 }),
  from:   fc.integer({ min: -30, max: 30 }),
  length: fc.integer({ min: 0, max: 120 }),
  hour:   fc.integer({ min: 7, max: 21 })
})

test("a series is on its rule's days, at its times, and no other day", () =>
  fc.assert(fc.property(weekdays, fc.integer({ min: 1, max: 60 }), ({ today, days, from, length, hour }, listed) => {
    const [first, last] = [addDays(today, from), addDays(today, from + length)]
    const one = seriesOn(between(first, last, weekly(...days)), hour, today)
    const events = fromCurated([one], today, listed, match)
    const expected = Array.from({ length: listed }, (_, i) => addDays(today, i)).filter(at => at >= first && at <= last && days.includes(WEEKDAYS[weekdayOf(at)]))
    expect(events.map(({ start }) => localDay(start))).toEqual(expected)
    for (const event of events)
      expect(event).toMatchObject({ source: "curated", place: "Murkland Hall", checked: today, start: atClock(localDay(event.start), one.sessions[0].start), end: atClock(localDay(event.start), one.sessions[0].end) })
    expect(new Set(events.map(({ id }) => id)).size).toBe(events.length)
  })))

test("a series' sessions each have their own days and times, told apart by their start, and each event is of its series", () =>
  fc.assert(fc.property(day.chain(base => fc.tuple(fc.constant(base), ruleNear(base, 30), ruleNear(base, 30))), fc.integer({ min: 7, max: 20 }), ([base, a, b], hour) => {
    const [from, until] = [base.subtract({ days: 40 }).toString(), base.add({ days: 40 }).toString()]
    const one = seriesOn(between(from, until, a), hour, from)
    const both = { ...one, sessions: [...one.sessions, { rule: between(from, until, b), start: `${String(hour + 1).padStart(2, "0")}:30`, end: `${String(hour + 2).padStart(2, "0")}:30` }] }
    const events = fromCurated([both], from, 81, match)
    expect(events).toHaveLength(both.sessions.reduce((n, session) => n + spansOf(session, plainDay(from), 81).length, 0))
    expect(new Set(events.map(({ id }) => id)).size).toBe(events.length)
    expect(events.every(event => slugIn(event.id) === slugOf(both.title))).toBe(true)
  })))

test("a series must end: a session with no last day, or ending before it starts, isn't one", () =>
  fc.assert(fc.property(weekdays, ({ today, days, hour }) => {
    const one = seriesOn(between(today, addDays(today, 30), weekly(...days)), hour, today)
    expect(v.safeParse(Curated, [one]).success).toBe(true)
    expect(v.safeParse(Curated, [seriesOn(weekly(...days), hour, today)]).success).toBe(false)
    expect(v.safeParse(Curated, [seriesOn(between(today, undefined, weekly(...days)), hour, today)]).success).toBe(false)
    expect(v.safeParse(Curated, [{ ...one, sessions: [{ ...one.sessions[0], end: one.sessions[0].start }] }]).success).toBe(false)
    expect(v.safeParse(Curated, [{ ...one, sessions: [] }]).success).toBe(false)
  })))

//#region The series as they were kept before rules

/** A series as curated.json kept it before sessions: weekdays, or the dates its page names, one start and end, from a day until a day */
type Flat = { title: string, where: string, days: string[], dates?: Day[], start: string, end: string, from: Day, until: Day, url: string, passage: string, checked: Day }

/** A flat series' events over some days, as fromCurated made them then */
const fromFlat = (series: readonly Flat[], from: Day, days: number): Event[] =>
  series.flatMap(one => Array.from({ length: days }, (_, i) => addDays(from, i))
    .filter(at => at >= one.from && at <= one.until)
    .filter(at => one.dates?.includes(at) || one.days.includes(WEEKDAYS[weekdayOf(at)]))
    .map(at => ({
      id:      `curated:${one.title.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${at}-${one.start.replace(":", "")}`,
      title:   one.title,
      start:   atClock(at, one.start),
      end:     atClock(at, one.end),
      place:   match(one.where),
      where:   one.where,
      source:  "curated" as const,
      url:     one.url,
      checked: one.checked
    })))

const byId = (a: Event, b: Event) => a.id.localeCompare(b.id)

test("the series kept as rules make the very events the flat lists of dates they replace did, over every day those ran", async () => {
  const flat: Flat[] = JSON.parse(await readFile(new URL("../fixtures/events/curated-flat.json", import.meta.url), "utf8"))
  const from = flat.map(one => one.from).sort()[0]
  const until = flat.map(one => one.until).sort().at(-1)!
  // From before the first to after the last, so nothing is on a day it wasn't
  const [first, days] = [addDays(from, -60), daysBetween(from, until) + 120]
  const now = fromCurated(kept, first, days, match)
  expect(now.length).toBeGreaterThan(20)
  expect([...now].sort(byId)).toEqual(fromFlat(flat, first, days).sort(byId))
  // Any window of it is the same too, as the build lists a few weeks a night
  fc.assert(fc.property(fc.integer({ min: 0, max: days }), fc.integer({ min: 1, max: 60 }), (after, length) => {
    expect(fromCurated(kept, addDays(first, after), length, match).sort(byId)).toEqual(fromFlat(flat, addDays(first, after), length).sort(byId))
  }))
})

test("the fixtures' series, which the fixture events are made of, have the café's two times as one series, and each ends", async () => {
  const series = v.parse(Curated, JSON.parse(await readFile(new URL("../fixtures/events/curated.json", import.meta.url), "utf8")))
  expect(series.find(({ title }) => title === "Le Café Français")!.sessions).toHaveLength(2)
  for (const one of series)
    for (const { rule } of one.sessions)
      expect(boundsOf(rule).until).toBeDefined()
})

//#endregion

test("every series kept says its days as its page's wording where the page names no dates, and reads back from a calendar file as the same days", () => {
  expect(kept.find(({ title }) => title === "AI Club")!.sessions[0].rule).toEqual({ of: { of: { weekly: ["Wed"] }, every: 2, from: "2026-11-18" }, between: ["2026-11-18", "2026-12-14"] })
  for (const one of kept) {
    const entries = entriesOf(one)
    expect(new Set(entries.map(({ uid }) => uid)).size).toBe(one.sessions.length)
    for (const [i, { session }] of entries.entries()) {
      const { from, until } = boundsOf(session.rule)
      const days = daysBetween(from!, until!) + 1
      const read = readEvents(writeCalendar(one.title, [entries[i]], instantAt(plainDay(from!), "12:00")))
      expect(read.flatMap(event => occurrences(event.session.rule, plainDay(from!), days).map(String)).sort()).toEqual(occurrences(session.rule, plainDay(from!), days).map(String))
      expect(read.every(event => event.title === one.title && event.where === one.where && event.session.start === session.start && event.session.end === session.end)).toBe(true)
    }
  }
  expect(v.safeParse(Curated, [seriesOn(on("2027-02-23"), 11, "2026-11-16")]).success).toBe(true)
})
