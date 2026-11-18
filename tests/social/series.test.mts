// What recurs, told once (src/social/series.mts): a session's series read from its id or link the same whatever day
// it's on, a one-off never one, the directory listing each activity once, with the weekdays it meets, how to join, and
// clubs that have posted no meeting, and a list folded with nothing dropped, what recurs gathered by kind, the kind
// whose next starts sooner first and practices last, and anything yours a row of its own; and saves
// (src/social/saves.mts), which save exactly the session tapped and follow exactly the activity named, keep a save
// through a merge, and let go of what's over

import { test, expect } from "vitest"
import fc from "fast-check"
import type { Event } from "../../src/social/event.mts"
import { FOLDS, directory, folded, interestOf, joinOf, recurs, seriesOf } from "../../src/social/series.mts"
import { NO_SAVES, isFollowed, isSaved, pruned, readSaves, savedId, setOccurrenceSaved, setSeriesFollowed } from "../../src/social/saves.mts"
import { isPractice } from "../../src/social/sport.mts"
import { atClock } from "../../src/shared/time.mts"

const HOUR = 3_600_000

/** A Tuesday at 5 PM in Durham, and the same a number of days on */
const at = (days = 0) =>
  atClock("2026-11-17", "17:00") + days * 24 * HOUR

const meeting = (club: string, days = 0): Event =>
  ({ id: `presence:${club}/meeting/2026-11-${17 + days}`, title: `${club} meeting`, start: at(days), end: at(days) + HOUR, where: "MUB 120", place: "Memorial Union Building", source: "presence", url: `https://unh.presence.io/organization/${club}` })

const rec = (title: string, program: string, days = 0): Event =>
  ({ id: `rec:${program}-${days}`, title, start: at(days), end: at(days) + HOUR, where: "Studio 2", place: "Hamel Rec Center", source: "rec", url: `https://crec.unh.edu/Program/GetProgramDetails?courseId=${program}&semesterId=x` })

const practice = (club: number, days = 0): Event =>
  ({ id: `dserec:${club}${days}`, title: "Tennis: Practice", start: at(days), end: at(days) + 2 * HOUR, where: "", source: "dserec", url: `https://unh.dserec.com/online/clubsports/club/${club}/events` })

const oneOff = (id: string, days = 0): Event =>
  ({ id, title: "UNH Men's Ice Hockey vs UConn", start: at(days), end: at(days) + 3 * HOUR, where: "", place: "Whittemore Center Arena", source: "athletics", url: "" })

test("a session's series is the same whatever day it's on, and a game, a booking or a sport club's game is no series", () => {
  expect(seriesOf(meeting("hillel"))).toEqual({ key: "presence:hillel", kind: "club", name: "hillel" })
  expect(seriesOf(meeting("hillel", 7))).toEqual(seriesOf(meeting("hillel")))
  expect(seriesOf(rec("Vinyasa Yoga", "abc", 1))?.key).toBe("rec:abc")
  expect(seriesOf(practice(22))).toEqual({ key: "dserec:22", kind: "practice", name: "Tennis" })
  expect(seriesOf({ ...practice(22), title: "Women's Soccer game: Maine" })).toBeUndefined()
  expect(seriesOf(oneOff("athletics:1"))).toBeUndefined()
  expect(seriesOf({ ...oneOff("curated:russian-conversation-hour-2026-11-20-1400"), source: "curated" })?.key).toBe("curated:russian-conversation-hour")
})

test("a club's meeting always recurs; anything else once it's on in two weeks, so two days of one fair don't", () => {
  expect(recurs("club", [meeting("a")])).toBe(true)
  expect(recurs("curated", [{ start: at(0) }, { start: at(1) }])).toBe(false)
  expect(recurs("rec", [{ start: at(0) }, { start: at(7) }])).toBe(true)
})

test("the directory lists each series once, with the weekdays it meets, its sessions to come soonest first, and an interest from its name", () => {
  const listings = directory([meeting("hillel", 7), meeting("hillel"), rec("Vinyasa Yoga", "y", 2), rec("Vinyasa Yoga", "y", 9), rec("Pancakes on Mt. Major", "p"), oneOff("athletics:1")], [], at(-1))
  expect(listings.map(({ name }) => name)).toEqual(["hillel", "Vinyasa Yoga"])
  const [hillel, yoga] = listings
  expect(hillel.days).toEqual([1])
  expect(hillel.sessions.map(({ start }) => start)).toEqual([at(0), at(7)])
  expect(yoga.days).toEqual([3])
  expect(yoga.interest).toBe("Fitness")
  expect(yoga.join).toBe("drop-in")
  expect(interestOf({ key: "presence:x", kind: "club", name: "Hillel" }, ["Culture & Identity"])).toBe("Culture & faith")
  expect(interestOf({ key: "dserec:1", kind: "practice", name: "Woodsmen" })).toBe("Sports")
  expect(joinOf("rec", [{ left: 4 }])).toBe("sign-up")
  expect(joinOf("club", [])).toBe("ask")
  // What's over is never listed; a club that's posted no meeting is, with none
  expect(directory([meeting("hillel")], [], at(1))).toEqual([])
  // A class down to its last session still recurs, by the sessions it's had
  expect(directory([rec("Cycling", "c", -7), rec("Cycling", "c")], [], at(-1))[0].sessions).toEqual([rec("Cycling", "c")])
  const [quiet] = directory([], [{ key: "presence:hillel", name: "Hillel", url: "https://unh.presence.io/organization/hillel", categories: [] }], at(1))
  expect(quiet).toMatchObject({ key: "presence:hillel", sessions: [], join: "ask" })
})

const LISTS = [
  ...["hillel", "girl-up", "sps"].flatMap(club => [meeting(club), meeting(club, 7)]),
  rec("Cycling", "c"), rec("Cycling", "c", 7), rec("Barre", "b"),
  practice(22), practice(25), oneOff("athletics:1"), oneOff("25live:2")
]

test("a list folded drops nothing, keeps each one-off a row, gathers what recurs by kind, sooner next first, and keeps anything yours a row of its own", () => {
  fc.assert(fc.property(fc.shuffledSubarray(LISTS), fc.shuffledSubarray(LISTS.map(({ id }) => id)), fc.integer({ min: -1, max: 26 }), (listed, yours, days) => {
    const events = [...listed].sort((a, b) => a.start - b.start)
    const keys = new Set(directory(LISTS, [], at(-1)).map(({ key }) => key))
    const isYours = (event: Event) => yours.includes(event.id)
    const { rows, folds } = folded(events, key => keys.has(key), isYours, at(days))
    expect([...rows, ...folds.flatMap(({ events }) => events)].map(({ id }) => id).sort()).toEqual(events.map(({ id }) => id).sort())
    expect(new Set(folds.map(({ fold }) => fold)).size).toBe(folds.length)
    // Practices last, as they're not for going to, and the rest by when their next starts
    const isLast = ({ fold }: { fold: string }) => Number(fold === "practice")
    for (const [i, { fold, next }] of folds.slice(1).entries())
      expect(isLast({ fold }) - isLast(folds[i]) || next.start - folds[i].next.start || FOLDS.indexOf(fold) - FOLDS.indexOf(folds[i].fold)).toBeGreaterThan(0)
    for (const { fold, events, next } of folds) {
      // Told by one of its own, the soonest still to start where any is
      expect(events).toContain(next)
      expect(events.some(({ start }) => start >= at(days) && (start < next.start || next.start < at(days)))).toBe(false)
      for (const event of events) {
        expect(isYours(event)).toBe(false)
        expect(fold === "practice" ? isPractice(event) : seriesOf(event)?.kind === fold).toBe(true)
      }
    }
    for (const event of rows)
      expect(isYours(event) || !isPractice(event) && !keys.has(seriesOf(event)?.key ?? "")).toBe(true)
  }))
})

test("saving a session saves that one alone, following an activity follows it alone, and each undone is as before", () => {
  fc.assert(fc.property(fc.shuffledSubarray(LISTS, { minLength: 1 }), fc.boolean(), (events, follow) => {
    let saves = NO_SAVES
    for (const event of events)
      saves = setOccurrenceSaved(saves, event, true, at(-1))
    if (follow)
      saves = setSeriesFollowed(saves, "presence:hillel", true)
    for (const event of LISTS)
      expect(isSaved(saves, event)).toBe(events.includes(event))
    expect(isFollowed(saves, "presence:hillel")).toBe(follow)
    let undone = setSeriesFollowed(saves, "presence:hillel", false)
    for (const event of events)
      undone = setOccurrenceSaved(undone, event, false, at(-1))
    expect(undone).toEqual(NO_SAVES)
  }))
  // Saving one Tuesday never saves next week's
  const tuesday = setOccurrenceSaved(NO_SAVES, meeting("hillel"), true, at(-1))
  expect(isSaved(tuesday, meeting("hillel", 7))).toBe(false)
})

test("a save made by one calendar's id is kept once another's telling is kept, by that id, so a calendar app's entry stays", () => {
  const saves = setOccurrenceSaved(NO_SAVES, oneOff("25live:9"), true, at(-1))
  const merged = { ...oneOff("athletics:1"), also: ["25live:9"] }
  expect(savedId(saves, merged)).toBe("25live:9")
  expect(setOccurrenceSaved(saves, merged, true, at(-1))).toEqual(saves)
  expect(setOccurrenceSaved(saves, merged, false, at(-1)).sessions).toEqual({})
})

test("saves let go of a session once it's over, keep what's followed, and read anything else as none", () => {
  const saves = setSeriesFollowed(setOccurrenceSaved(NO_SAVES, oneOff("athletics:1"), true, at(-1)), "presence:hillel", true)
  expect(pruned(saves, at(1))).toEqual({ sessions: {}, follows: ["presence:hillel"] })
  expect(readSaves({ sessions: [], follows: "x" })).toEqual(NO_SAVES)
  expect(readSaves(null)).toEqual(NO_SAVES)
})
