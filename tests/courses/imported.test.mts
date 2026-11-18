import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { LETTERS } from "../../src/courses/calendar.mts"
import { type Section, clock, courseOf, meets, sessionOf } from "../../src/courses/course.mts"
import { type Imported, type Kept, createMatcher, importedFrom, importedOn, isClassAt, keptOf, readKept, withKept } from "../../src/courses/imported.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { type Rule, WEEKDAYS, between, occurrences, weekly } from "../../src/shared/recur.mts"
import { dayAt, instantAt, plainDay } from "../../src/shared/temporal.mts"
import { TIME_ZONE, addDays, localDay, localMinutes } from "../../src/shared/time.mts"
import { clock as anyClock, day, ruleNear } from "../shared/rules.mts"
import { calendar, fall, spring } from "./fixtures.mts"

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/calendars/${name}`, import.meta.url), "utf8")

const gazetteer: { places: { name: string }[] } = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const matchOf = createMatcher([fall, spring], calendar, placeMatcher(gazetteer.places.map(({ name }) => name)))

/** A day within the fixtures' fall term, for an event's occurrences to be compared with its classes from */
const inTerm = fc.integer({ min: 0, max: 60 }).map(days => addDays(fall.from, days))

const event = (title: string, where: string, rule: Rule, start: string, zone = TIME_ZONE): Imported =>
  ({ uid: title, title, where, zone, session: { rule, start, end: start } })

test("a calendar's events worth keeping are those at a time, not cancelled, not long over, with only what shows them", async () => {
  const kept = importedFrom(await fixture("google.ics"), "2026-10-27")
  expect(kept.map(({ title }) => title)).toEqual(["CS 518", "CS 518 (moved)", "CS 518 lab", "AI Club", "Chess club", "Call home", "Late skate"])
  expect(kept.every(one => Object.keys(one).sort().join() === "session,title,uid,where,zone")).toBe(true)
  // Once its day is past, an event that never repeats is left out; one that goes on is kept
  expect(importedFrom(await fixture("google.ics"), "2026-12-20").map(({ title }) => title)).toEqual(["Chess club", "Call home"])
  expect(importedFrom(await fixture("canvas.ics"), "2026-11-01").map(({ title }) => title)).toEqual(["Lecture [CS518.01-FA26]", "Lecture [CS518.01-FA26]", "Lab report 4 [CHEM403.L02-FA26]", "Exam review session [PSYC401.02-FA26]"])
  expect(importedFrom("not a calendar", "2026-11-01")).toEqual([])
})

test("the events on some Durham days are those starting within them, whatever zone each is in, and days on end share them out", () =>
  fc.assert(fc.property(day.chain(base => fc.tuple(fc.constant(base), fc.array(fc.tuple(ruleNear(base, 40), anyClock, fc.constantFrom(TIME_ZONE, "UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland")), { maxLength: 4 }))), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), ([base, made], a, b) => {
    const events = made.map(([rule, start, zone], i) => event(`Event ${i}`, "", rule, start, zone))
    const from = base.toString()
    const found = importedOn(events, from, a + b)
    const [opens, closes] = [instantAt(base, "00:00"), instantAt(base.add({ days: a + b }), "00:00")]
    expect(found.every(({ start }) => start >= opens && start < closes)).toBe(true)
    expect(found.map(({ start }) => start)).toEqual([...found.map(({ start }) => start)].sort((x, y) => x - y))
    expect(found).toEqual([...importedOn(events, from, a), ...importedOn(events, addDays(from, a), b)])
    // Each is its event's own day and time where it is
    for (const { event: { zone, session }, start } of found) {
      const there = dayAt(start, zone)
      expect(occurrences(session.rule, there, 1)).toHaveLength(1)
      expect(instantAt(there, session.start, zone)).toBe(start)
    }
  })))

//#region Matching

const timed = fall.sections.filter(meets)

/** A section's meeting with days, and a day's worth of minutes its start may be off by */
const meeting = fc.constantFrom(...timed).chain(section => fc.record({
  section: fc.constant(section),
  meeting: fc.constantFrom(...section.meetings.filter(({ days }) => days)),
  off:     fc.integer({ min: -15, max: 15 })
}))

/** Whether two sections are one class as far as a calendar can tell: the same course, meeting at the same times */
const isSameClass = (a: Section, b: Section, start: number) =>
  courseOf(a) === courseOf(b) && b.meetings.some(other => Math.abs(other.start - start) <= 30)

test("an event titled with its course's code, on its meeting's days about when it starts, is that course's section meeting then; with its section number, that very section", () =>
  fc.assert(fc.property(meeting, inTerm, fc.constantFrom("", " lecture", ": week 9"), ({ section, meeting, off }, from, words) => {
    const start = clock(Math.min(Math.max(meeting.start + off, 0), 1439))
    const rule = between(meeting.from, meeting.to, weekly(...[...meeting.days].map(letter => WEEKDAYS[LETTERS.indexOf(letter as typeof LETTERS[number])])))
    const byCode = matchOf(event(`${section.subject} ${section.number}${words}`, "", rule, start), from)
    expect(byCode.found && isSameClass(section, byCode.found.section, meeting.start)).toBe(true)
    // As Canvas writes it, where the section's number is digits, as most are
    const bySection = matchOf(event(`Lecture [${section.subject}${section.number}.${section.section}-FA26]`, "", rule, start), from)
    expect(bySection.found?.section.subject).toBe(section.subject)
    if (/^\d+$/.test(section.section))
      expect(bySection.found?.section).toBe(section)
    expect(byCode.place).toBe(byCode.found!.section.meetings.find(other => Math.abs(other.start - meeting.start) <= 30 && other.place)?.place ?? byCode.found!.section.meetings.find(other => other.place)?.place)
  }), { numRuns: 200 }))

test("an event with no code in the room a class meets in, when it meets, is that class; in the room at another time, or with nothing the app knows, it's only itself", () => {
  fc.assert(fc.property(meeting.filter(({ meeting }) => meeting.place !== undefined), inTerm, ({ section, meeting }, from) => {
    const rule = sessionOf(meeting, calendar).rule
    const found = matchOf(event("Class", meeting.where, rule, clock(meeting.start)), from)
    // Only where the meeting still has days to come by then
    fc.pre(importedOn([event("Class", meeting.where, rule, clock(meeting.start))], from, 28).length > 0)
    expect(found.place).toBe(meeting.place)
    expect(found.found?.section.meetings.some(other => other.where === meeting.where && other.start === meeting.start)).toBe(true)
    expect(found.found?.section === section || found.found!.section.crn !== section.crn).toBe(true)
    const [another] = [(meeting.start + 300) % 1440].filter(minutes => !timed.some(other => other.meetings.some(its => its.place === meeting.place && its.where.split(" ").at(-1) === meeting.where.split(" ").at(-1) && Math.abs(its.start - minutes) <= 15)))
    if (another !== undefined)
      expect(matchOf(event("Class", meeting.where, rule, clock(another)), from)).toEqual({ place: meeting.place })
  }), { numRuns: 100 })
  fc.assert(fc.property(inTerm, anyClock, (from, start) => {
    expect(matchOf(event("Call home", "", between(fall.from, fall.to, weekly("Tue")), start), from)).toEqual({})
    expect(matchOf(event("ROOM 101 walkthrough", "Zoom", between(fall.from, fall.to, weekly("Tue")), start), from)).toEqual({})
  }))
})

test("an imported class is one told already when it's that section's, or one's cross-listed with it, within a quarter of an hour of its start", () => {
  const pair = fall.sections.find(section => section.crossListed.some(crn => fall.sections.some(other => other.crn === crn)))!
  const twin = fall.sections.find(({ crn }) => pair.crossListed.includes(crn))!
  const another = fall.sections.find(({ crn, crossListed }) => crn !== pair.crn && crn !== twin.crn && !crossListed.includes(pair.crn))!
  fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 41 }), fc.integer({ min: -90, max: 90 }), (start, minutes) => {
    const imported = { event: event("Lecture", "", between(fall.from, fall.to, weekly("Tue")), "10:10"), start, end: start, match: { found: { term: fall, section: pair } } }
    for (const section of [pair, twin])
      expect(isClassAt(imported, section, start + minutes * 60_000)).toBe(Math.abs(minutes) <= 15)
    expect(isClassAt(imported, another, start)).toBe(false)
    expect(isClassAt({ ...imported, match: {} }, pair, start)).toBe(false)
  }))
})

test("the feeds' own classes are found: Google's by code and time, the lab by its Friday, Canvas' by its bracketed section, Outlook's among a course's sections by when it meets", async () => {
  const of = async (name: string, title: string) => {
    const found = importedFrom(await fixture(name), "2026-10-27").find(one => one.title === title)!
    return matchOf(found, "2026-10-27")
  }
  const cs518 = fall.sections.find(section => courseOf(section) === "CS 518")!
  expect(await of("google.ics", "CS 518")).toEqual({ found: { term: fall, section: cs518 }, place: "Kingsbury Hall" })
  expect(await of("google.ics", "CS 518 lab")).toEqual({ found: { term: fall, section: cs518 }, place: "Kingsbury Hall" })
  expect(await of("canvas.ics", "Lecture [CS518.01-FA26]")).toEqual({ found: { term: fall, section: cs518 }, place: "Kingsbury Hall" })
  expect(await of("google.ics", "AI Club")).toEqual({ place: "Memorial Union Building" })
  expect(await of("google.ics", "Call home")).toEqual({})
  const psyc = await of("outlook.ics", "PSYC 401")
  expect(courseOf(psyc.found!.section)).toBe("PSYC 401")
  expect(psyc.found!.section.meetings.some(({ days, start }) => days === "MWF" && Math.abs(start - 13 * 60) <= 15)).toBe(true)
})

//#endregion

test("a calendar read again by its address takes the place of the one before, a file is its own, and what's stored that isn't a calendar is left out", async () => {
  const ics = await fixture("google.ics")
  const now = instantAt(plainDay("2026-10-27"), "12:00")
  fc.assert(fc.property(fc.webUrl({ validSchemes: ["https"] }), fc.webUrl({ validSchemes: ["https"] }), fc.integer({ min: 1, max: 1e6 }), (url, other, later) => {
    fc.pre(url !== other)
    const first = keptOf(ics, { url, name: "x" }, now)
    expect(first).toMatchObject({ id: url, url, name: "Classes", at: now })
    expect(localDay(first.at)).toBe("2026-10-27")
    const kept: Kept[] = withKept(withKept([], first), keptOf(ics, { url: other }, now))
    expect(kept.map(({ id }) => id)).toEqual([url, other])
    const again = withKept(kept, keptOf(ics, { url }, now + later))
    expect(again.map(({ id, at }) => [id, at])).toEqual([[url, now + later], [other, now]])
    expect(readKept(JSON.parse(JSON.stringify(again)))).toEqual(again)
  }))
  expect(keptOf("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { name: "schedule" }, now)).toMatchObject({ name: "schedule", events: [] })
  expect(readKept([{ id: "x" }, null, "calendar", { id: "y", name: "Y", at: 1, events: [{ uid: "u" }] }])).toEqual([])
  expect(readKept(null)).toEqual([])
  // An event's start on Durham's clock, for the test above to have compared minutes with
  expect(localMinutes(now)).toBe(12 * 60)
})
