import { test, expect } from "vitest"
import fc from "fast-check"
import { LETTERS, letterOf } from "../../src/courses/calendar.mts"
import { type Section, activeTerms, clock, meetingKeys, occurrences, onDay, standing, termOf } from "../../src/courses/course.mts"
import { createSchedule, dedupe } from "../../src/courses/rooms.mts"
import { addDays, atClock, localDay, localMinutes, weekday } from "../../src/shared/time.mts"
import { calendar, fall, jterm, rawRows, spring } from "./fixtures.mts"

const timed = fall.sections.filter(section => section.meetings.some(meeting => meeting.days))
const aSection = fc.constantFrom(...timed)
const aDay = fc.integer({ min: -10, max: 130 }).map(offset => addDays(fall.from, offset))
const aClock = fc.integer({ min: 0, max: 1439 }).map(clock)
/** A section with its meetings in some other order, as the source may list them tomorrow */
const shuffled = (section: Section, order: number[]): Section =>
  ({ ...section, meetings: order.map(i => section.meetings[i]) })
const aPermutation = (n: number) => fc.shuffledSubarray(Array.from({ length: n }, (_, i) => i), { minLength: n, maxLength: n })
const aShuffledSection = aSection.chain(section => fc.tuple(fc.constant(section), aPermutation(section.meetings.length)))

test("the import is whole: every row a section, each CRN once, in-person meetings placed, and the stamps honest", () => {
  expect(fall.sections.length).toBe(rawRows.length)
  expect(new Set(fall.sections.map(section => section.crn)).size).toBe(fall.sections.length)
  const meetings = fall.sections.flatMap(section => section.meetings)
  const inPerson = meetings.filter(meeting => meeting.days && !/^(TBA|On-line course|Off Campus|UNH courses abroad)/.test(meeting.where))
  expect(inPerson.filter(meeting => meeting.place).length / inPerson.length).toBe(1)
  for (const meeting of meetings)
    expect(meeting.where).not.toMatch(/@|\.edu/)
  expect(fall.fetched).toBeLessThan(fall.built)
  expect(fall).toMatchObject({ code: "202610", name: "Fall 2026", from: "2026-08-31", to: "2026-12-14" })
})

test("an occurrence falls on a listed weekday, or the weekday the day follows, within the meeting's dates, never on a no-class day, soonest first", () =>
  fc.assert(fc.property(aSection, aDay, (section, day) => {
    const events = occurrences(fall, section, calendar, day)
    const keys = meetingKeys(section)
    for (const event of events) {
      const meeting = section.meetings[keys.indexOf(event.key)]
      expect(meeting.days).toContain(letterOf(calendar, day, weekday(day)))
      expect(meeting.from <= day && day <= meeting.to).toBe(true)
      expect(calendar.noClass).not.toContain(day)
      expect(localDay(event.start)).toBe(day)
      expect(localMinutes(event.start)).toBe(meeting.start)
      expect(localMinutes(event.end)).toBe(meeting.end)
      expect(event.id).toBe(`course:202610:${section.crn}:${day}:${event.key}`)
    }
    for (let i = 1; i < events.length; i++)
      expect(events[i].start).toBeGreaterThanOrEqual(events[i - 1].start)
    const should = section.meetings.filter(meeting => meeting.days.includes(letterOf(calendar, day, weekday(day))) && meeting.from <= day && day <= meeting.to).length
    expect(events.length).toBe(calendar.noClass.includes(day) ? 0 : should)
  }))
)

test("an occurrence's id is keyed by the meeting's content, so it doesn't depend on the order the source lists the section's meetings in", () =>
  fc.assert(fc.property(aShuffledSection, aDay, ([section, order], day) => {
    const ids = occurrences(fall, section, calendar, day).map(event => event.id).sort()
    expect(occurrences(fall, shuffled(section, order), calendar, day).map(event => event.id).sort()).toEqual(ids)
  }))
)

test("a swap day runs the other weekday's classes: 13 October 2026 follows a Wednesday, so Tuesday-only classes don't meet and Wednesday ones do", () => {
  const swapDay = "2026-10-13"
  expect(calendar.swaps).toEqual({ [swapDay]: "W" })
  const tuesdayOnly = timed.filter(section => section.meetings.every(meeting => !meeting.days || meeting.days === "T" || meeting.days === "TR"))
  const wednesday = timed.filter(section => section.meetings.some(meeting => meeting.days === "W" && meeting.from <= swapDay && swapDay <= meeting.to))
  expect(tuesdayOnly.length).toBeGreaterThan(20)
  expect(wednesday.length).toBeGreaterThan(5)
  expect(onDay(fall, calendar, swapDay, tuesdayOnly)).toEqual([])
  expect(onDay(fall, calendar, swapDay, wednesday).length).toBeGreaterThan(0)
  expect(onDay(fall, calendar, addDays(swapDay, -7), tuesdayOnly).length).toBeGreaterThan(0)
})

test("no classes on Thanksgiving, Labor Day or Veterans Day, and classes on every other weekday of the term", () => {
  for (const day of calendar.noClass)
    expect(onDay(fall, calendar, day)).toEqual([])
  let weekdays = 0
  for (let day = fall.from; day <= fall.to; day = addDays(day, 1))
    if (weekday(day) < 5 && !calendar.noClass.includes(day)) {
      weekdays++
      expect(onDay(fall, calendar, day).length).toBeGreaterThan(50)
    }
  expect(weekdays).toBeGreaterThan(65)
})

test("what's scheduled at a place now is the brute-force answer with each physical class once", () => {
  const schedule = createSchedule([fall], calendar)
  const places = [...new Set(fall.sections.flatMap(section => section.meetings.flatMap(meeting => meeting.place ?? [])))]
  fc.assert(fc.property(fc.constantFrom(...places), aDay, aClock, (place, day, time) => {
    const now = atClock(day, time)
    const slow = onDay(fall, calendar, day).filter(event => event.place === place && event.start <= now && now < event.end).map(event => event.id).sort()
    const fast = schedule.now({ place }, now)
    expect(fast.flatMap(({ event, also }) => [event.id, ...also.map(section => event.id.replace(event.crn, section.crn))]).sort()).toEqual(slow)
    for (const { section, also } of fast)
      for (const twin of also)
        expect(section.crossListed.includes(twin.crn) || twin.crossListed.includes(section.crn)).toBe(true)
    // A room's own answer is the building's, narrowed to it
    for (const { meeting } of fast)
      expect(schedule.now({ room: meeting.where.toLowerCase() }, now).map(({ event }) => event.id))
        .toEqual(fast.filter(other => other.meeting.where === meeting.where).map(({ event }) => event.id))
  }), { numRuns: 60 })
  expect(schedule.now({ place: "Kingsbury Hall" }, atClock("2026-10-14", "12:00")).length).toBeGreaterThan(0)
})

test("a place's day is every class there that day once, soonest first, and its rooms are those ever scheduled there", () =>
  fc.assert(fc.property(aDay, day => {
    const schedule = createSchedule([fall], calendar)
    const list = schedule.on({ place: "Kingsbury Hall" }, day)
    for (let i = 1; i < list.length; i++)
      expect(list[i].event.start).toBeGreaterThanOrEqual(list[i - 1].event.start)
    const all = onDay(fall, calendar, day).filter(event => event.place === "Kingsbury Hall")
    expect(list.length + list.reduce((n, { also }) => n + also.length, 0)).toBe(all.length)
    for (const { meeting } of list)
      expect(schedule.roomsIn("Kingsbury Hall")).toContain(meeting.where)
  }), { numRuns: 30 })
)

test("cross-listed sections meeting together are one class: a kept class and each section folded into it share a room, a time and a cross-listing, and no two kept classes do", () => {
  const listed = fall.sections.filter(section => section.crossListed.length && section.meetings.some(meeting => meeting.days && meeting.place))
  expect(listed.length).toBeGreaterThan(20)
  const sample = listed.map(section => ({ section, meeting: section.meetings[0], also: [] as Section[] }))
  const kept = dedupe(sample)
  const linked = (a: Section, b: Section) => a.crossListed.includes(b.crn) || b.crossListed.includes(a.crn)
  const same = (a: typeof sample[number], b: typeof sample[number]) => a.meeting.where === b.meeting.where && a.meeting.start === b.meeting.start && a.meeting.end === b.meeting.end
  expect(kept.length).toBeLessThan(sample.length)
  expect(kept.reduce((n, { also }) => n + also.length, 0)).toBe(sample.length - kept.length)
  for (const keeper of kept)
    for (const twin of keeper.also)
      expect(linked(keeper.section, twin) && same(keeper, sample.find(s => s.section === twin)!)).toBe(true)
  for (const a of kept)
    for (const b of kept)
      if (a !== b)
        expect(linked(a.section, b.section) && same(a, b)).toBe(false)
})

test("a section's standing is the meeting under way and the next to start, whichever order the source lists its meetings in", () =>
  fc.assert(fc.property(aShuffledSection, aDay, aClock, ([section, order], day, time) => {
    const now = atClock(day, time)
    const all = Array.from({ length: 21 }, (_, i) => occurrences(fall, section, calendar, addDays(day, i))).flat().sort((a, b) => a.start - b.start)
    const { current, next } = standing(fall, section, calendar, now)
    expect(current?.id).toBe(all.find(event => event.start <= now && now < event.end)?.id)
    expect(next?.id).toBe(all.find(event => event.start > now)?.id)
    if (next)
      expect(next.start).toBeGreaterThan(now)
    const again = standing(fall, shuffled(section, order), calendar, now)
    expect(again.current?.id).toBe(current?.id)
    expect(again.next?.id).toBe(next?.id)
  }))
)

test("CEE 400 (05) lists its Monday 2:10 meeting before its 12:10 lecture, and the next start on a Monday morning is still 12:10", () => {
  const section = fall.sections.find(section => section.crn === "15646")!
  expect(section.meetings.map(meeting => meeting.start)).toEqual([850, 730])
  const { current, next } = standing(fall, section, calendar, atClock("2026-10-26", "09:00"))
  expect(current).toBeUndefined()
  expect(localMinutes(next!.start)).toBe(730)
  expect(next!.where).toBe("Kingsbury N334")
  // At 1 PM the lecture is over and the 2:10 is next; at 2:30 it's under way and Wednesday's lecture is next
  expect(localMinutes(standing(fall, section, calendar, atClock("2026-10-26", "13:00")).next!.start)).toBe(850)
  const during = standing(fall, section, calendar, atClock("2026-10-26", "14:30"))
  expect(during.current?.where).toBe("Kingsbury N121")
  expect(localDay(during.next!.start)).toBe("2026-10-28")
})

test("CS 518 (01) meets in N343 on Tuesday and Thursday and in N113 on Friday, and each day's occurrence says its own room", () => {
  const section = fall.sections.find(section => section.crn === "12496")!
  expect(occurrences(fall, section, calendar, "2026-10-27")[0].where).toBe("Kingsbury N343")
  expect(occurrences(fall, section, calendar, "2026-10-30")[0].where).toBe("Kingsbury N113")
  expect(new Set(section.meetings.map(meeting => meeting.where)).size).toBe(2)
})

test("the live terms at an instant are those running or starting within two weeks: fall alone in October, J-Term in late December, J-Term and spring overlapping in January", () => {
  const terms = [fall, jterm, spring]
  const live = (day: string) => activeTerms(terms, atClock(day, "12:00")).map(term => term.code)
  expect(live("2026-10-26")).toEqual(["202610"])
  expect(live("2026-12-20")).toEqual(["202630"])
  expect(live("2027-01-20")).toEqual(["202630", "202650"])
  expect(live("2027-03-01")).toEqual(["202650"])
  // A term is live from `lead` days before it starts through its last day, never outside
  fc.assert(fc.property(fc.integer({ min: -60, max: 200 }), fc.integer({ min: 0, max: 30 }), (offset, lead) => {
    const day = addDays(fall.from, offset)
    expect(activeTerms([fall], atClock(day, "12:00"), lead).length).toBe(offset >= -lead && day <= fall.to ? 1 : 0)
  }))
})

test("a term joins its index entry and its file only when they agree", () => {
  const { sections, built, ...entry } = fall
  const joined = termOf({ built }, { ...entry, sections: sections.length, file: "/data/courses/x.json" }, { code: "202610", sections })
  expect(joined).toEqual(fall)
  expect(() => termOf({ built }, { ...entry, sections: sections.length, file: "/data/courses/x.json" }, { code: "202650", sections })).toThrow(/isn't the term/)
  expect(() => termOf({ built }, { ...entry, sections: 1, file: "/data/courses/x.json" }, { code: "202610", sections })).toThrow(/isn't the term/)
})

test("expanding a whole day of a term takes milliseconds", () => {
  const started = performance.now()
  expect(onDay(fall, calendar, "2026-10-14").length).toBeGreaterThan(100)
  expect(performance.now() - started).toBeLessThan(100)
})

test("letters stand for weekdays Monday first, as the registrar writes them", () => {
  expect(LETTERS.join("")).toBe("MTWRFSU")
  const section: Section = { ...timed[0], meetings: [{ days: "R", start: 600, end: 660, from: fall.from, to: fall.to, where: "x" }] }
  const thursday = "2026-10-15"
  expect(weekday(thursday)).toBe(3)
  expect(occurrences(fall, section, calendar, thursday)).toHaveLength(1)
  expect(occurrences(fall, section, calendar, addDays(thursday, 1))).toHaveLength(0)
})
