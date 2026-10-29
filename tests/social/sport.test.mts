// What kind of thing an event is, the same thing told by more than one calendar, and a list's practices gathered
// (src/social/sport.mts): told once whatever order, the same again on its own answer, and nothing ever dropped

import { test, expect } from "vitest"
import fc from "fast-check"
import { type Event, SOURCES } from "../../src/social/event.mts"
import { deduped, gathered, isPractice, isSame } from "../../src/social/sport.mts"
import { localDay } from "../../src/shared/time.mts"

const HOUR = 3_600_000
const at = Date.UTC(2026, 9, 31, 15)

const event = (id: string, title: string, source: Event["source"], start = at, place: string | undefined = "Whittemore Center Arena"): Event =>
  ({ id, title, start, end: start + 2 * HOUR, place, where: place ?? "", source, url: "" })

test("a practice, hold, camp, rehearsal or tryout isn't for going to; a game, meet or tournament is, whatever it's called by, as is anything a person made", () => {
  for (const title of ["Baseball: Practice", "HOLD for Admissions", "Wildcat Camp", "Dance Team Rehearsal", "Rugby Tryouts", "INDOOR POOL CLOSED"])
    expect(isPractice(event(title, title, "25live"))).toBe(true)
  for (const title of ["Women’s Ice Hockey game: Holy Cross", "Men's Volleyball: Home Tournament", "Woodsmen tournament: Home Meet", "Take Back The Night"])
    expect(isPractice(event(title, title, "dserec"))).toBe(false)
  expect(isPractice(event("a", "Practice Night", "athletics"))).toBe(false)
  expect(isPractice(event("b", "Pickup soccer practice", "pin"))).toBe(false)
})

test("the same game told by two calendars is one, but men's isn't women's, nor a game hours later or elsewhere", () => {
  const varsity = event("athletics:1", "UNH Women's Ice Hockey vs Holy Cross - Post-Game Autographs", "athletics")
  const listed = event("25live:2", "Women's Ice Hockey vs. Holy Cross", "25live", at + 15 * 60_000)
  expect(isSame(varsity, listed)).toBe(true)
  expect(isSame(varsity, event("25live:3", "Men's Ice Hockey vs. Holy Cross", "25live"))).toBe(false)
  expect(isSame(varsity, { ...listed, start: at + 3 * HOUR })).toBe(false)
  expect(isSame(varsity, { ...listed, place: "Field House" })).toBe(false)
  expect(deduped([listed, varsity])).toEqual([{ ...varsity, also: ["25live:2"] }])
})

const PLACES = ["Whittemore Center Arena", "Bremner Field", undefined]
const TITLES = ["UNH Women's Ice Hockey vs Holy Cross", "Women's Ice Hockey game: Holy Cross", "Men's Ice Hockey vs. UConn", "Baseball: Practice", "Baseball practice", "Take Back The Night", "Wildcat Camp"]
const events = fc.uniqueArray(fc.record({
  n:      fc.nat(999),
  title:  fc.constantFrom(...TITLES),
  source: fc.constantFrom(...SOURCES),
  start:  fc.integer({ min: 0, max: 8 }).map(quarter => at + quarter * 15 * 60_000),
  place:  fc.constantFrom(...PLACES)
}), { selector: ({ n }) => n, maxLength: 14 }).map(made => made.map(({ n, title, source, start, place }) => event(`${source}:${n}`, title, source, start, place)))

/** Every id an answer has, its events' own and those they carry */
const idsOf = (list: readonly Event[]) =>
  list.flatMap(event => [event.id, ...event.also ?? []]).sort()

test("telling each thing once drops nothing, is the same whatever order, and the same again on its own answer", () => {
  fc.assert(fc.property(events, fc.nat(), (made, seed) => {
    const once = deduped(made)
    expect(idsOf(once)).toEqual(made.map(event => event.id).sort())
    const shuffled = made.map((event, i) => ({ event, key: (i * 7919 + seed) % 1009 })).sort((a, b) => a.key - b.key).map(({ event }) => event)
    expect(deduped(shuffled)).toEqual(once)
    expect(deduped(once)).toEqual(once)
    // What's kept of a thing is one of its own tellings
    for (const kept of once)
      expect(made).toContainEqual(Object.fromEntries(Object.entries(kept).filter(([key]) => key !== "also")))
  }))
})

test("a list's practices follow the rest, a lone one on a day as a muted row and more as one line, and every event is in exactly one line", () => {
  fc.assert(fc.property(events, made => {
    const lines = gathered(made)
    const listed = lines.flatMap(line => "event" in line ? [line.event] : line.practices)
    expect(listed.map(event => event.id).sort()).toEqual(made.map(event => event.id).sort())
    const firstPractice = lines.findIndex(line => !("event" in line) || line.isMuted)
    expect(firstPractice === -1 || lines.slice(firstPractice).every(line => !("event" in line) || line.isMuted)).toBe(true)
    const days = lines.flatMap(line => "event" in line ? (line.isMuted ? [localDay(line.event.start)] : []) : [localDay(line.practices[0].start)])
    expect(new Set(days).size).toBe(days.length)
    for (const line of lines)
      if ("practices" in line) {
        expect(line.practices.length).toBeGreaterThan(1)
        expect(line.practices.every(isPractice)).toBe(true)
        expect(new Set(line.practices.map(event => localDay(event.start))).size).toBe(1)
      }
      else
        expect(isPractice(line.event)).toBe(line.isMuted)
  }))
})
