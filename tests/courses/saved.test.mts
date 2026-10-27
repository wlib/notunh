import { test, expect } from "vitest"
import fc from "fast-check"
import { activeTerms, occurrences, standing } from "../../src/courses/course.mts"
import type { Found } from "../../src/courses/search.mts"
import { datedOn, isSaved, keyOf, nextOf, parseKey, patternsOf, readSaved, resolverOf, savedIn, weekOf, withSaved, withoutSaved } from "../../src/courses/saved.mts"
import { thereBy } from "../../src/shared/visit.mts"
import { DAY, addDays, atClock, dayStart, localDay, weekday } from "../../src/shared/time.mts"
import { calendar, fall, jterm, spring } from "./fixtures.mts"

const terms = [fall, jterm, spring]
const timed = fall.sections.filter(section => section.meetings.some(meeting => meeting.days && meeting.place))
const crossListed = fall.sections.filter(section => section.crossListed.some(crn => fall.sections.some(other => other.crn === crn)))
const aFound = fc.constantFrom(...timed).map((section): Found => ({ term: fall, section }))
const someFound = fc.uniqueArray(aFound, { maxLength: 6, selector: ({ section }) => section.crn })
/** An instant within the fall term, give or take a week */
const anInstant = fc.integer({ min: dayStart(addDays(fall.from, -7)), max: dayStart(addDays(fall.to, 7)) })
const keysOf = (found: readonly Found[]) =>
  found.map(({ term, section }) => keyOf(term.code, section.crn))

test("what's stored is read as well-formed keys, each once, in order, whatever an older version wrote", () =>
  fc.assert(fc.property(fc.array(fc.oneof(fc.jsonValue(), fc.constantFrom("202610:12496", "202650:10001", "202610:1249", "x"))), stored => {
    const keys = readSaved(stored)
    expect(keys.every(key => parseKey(key) !== undefined)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([...new Set(stored.filter((key): key is string => typeof key === "string" && parseKey(key) !== undefined))])
    expect(readSaved({ not: "a list" })).toEqual([])
  })))

test("saving is idempotent, a section cross-listed with one saved is already saved, and forgetting either forgets the class", () =>
  fc.assert(fc.property(someFound, fc.constantFrom(...crossListed), (found, section) => {
    const twin = fall.sections.find(other => section.crossListed.includes(other.crn))!
    const keys = keysOf(found)
    const once = withSaved(keys, { term: fall, section })
    expect(withSaved(once, { term: fall, section })).toEqual(once)
    expect(withSaved(once, { term: fall, section: twin })).toEqual(once)
    expect(isSaved(once, { term: fall, section: twin })).toBe(true)
    const forgotten = withoutSaved(once, { term: fall, section: twin })
    expect(isSaved(forgotten, { term: fall, section })).toBe(false)
    expect(isSaved(forgotten, { term: fall, section: twin })).toBe(false)
  })))

test("saving both of a cross-listed pair, as a pasted schedule may, lists the class once, and its week has it once a meeting", () => {
  const section = crossListed.find(section => section.meetings.some(meeting => meeting.days))!
  const twin = fall.sections.find(other => section.crossListed.includes(other.crn))!
  const keys = [keyOf(fall.code, section.crn), keyOf(fall.code, twin.crn)]
  const saved = savedIn(keys, terms)
  expect(saved.map(({ section }) => section.crn)).toEqual([section.crn])
  // Even read straight from both sections, a meeting they share is one class
  for (let day = fall.from; day <= addDays(fall.from, 13); day = addDays(day, 1))
    expect(datedOn([{ term: fall, section }, { term: fall, section: twin }], calendar, day).length).toBe(occurrences(fall, section, calendar, day).length)
})

test("a term past its end drops out of what's saved by itself, as only the live terms are read", () => {
  const keys = [keyOf(fall.code, timed[0].crn), keyOf(spring.code, spring.sections[0].crn)]
  const during = activeTerms(terms, atClock(addDays(fall.to, -1), "12:00"))
  const after = activeTerms(terms, atClock(addDays(fall.to, 1), "12:00"))
  expect(savedIn(keys, during).map(({ term }) => term.code)).toContain(fall.code)
  expect(savedIn(keys, after).map(({ term }) => term.code)).not.toContain(fall.code)
})

test("the next class is the soonest of the saved sections' next starts, whatever order they were saved in", () =>
  fc.assert(fc.property(someFound, anInstant, (found, now) => {
    const next = nextOf(found, calendar, now)
    const starts = found.flatMap(({ term, section }) => standing(term, section, calendar, now).next?.start ?? [])
    expect(next?.event.start).toBe(starts.length ? Math.min(...starts) : undefined)
    expect(nextOf(found.toReversed(), calendar, now)?.event.start).toBe(next?.event.start)
    if (next)
      expect(next.event.start).toBeGreaterThan(now)
  })))

test("a class reminder's queue resolves to the section's meetings still to come, soonest first, placed, at no offset, never on a no-class day nor past its last", () =>
  fc.assert(fc.property(aFound, anInstant, ({ section }, now) => {
    const visits = resolverOf(terms, calendar, () => now)(keyOf(fall.code, section.crn))
    const last = section.meetings.reduce((last, { to }) => to > last ? to : last, section.to)
    for (const [i, visit] of visits.entries()) {
      expect(visit.arriveBy).toBeGreaterThan(now)
      expect(visit.offset).toBe(0)
      expect(thereBy(visit)).toBe(visit.arriveBy)
      expect(calendar.noClass).not.toContain(localDay(visit.arriveBy))
      expect(localDay(visit.arriveBy) <= last).toBe(true)
      expect(visit.occurrence?.id).toMatch(new RegExp(`^course:${fall.code}:${section.crn}:`))
      if (i)
        expect(visit.arriveBy).toBeGreaterThanOrEqual(visits[i - 1].arriveBy)
    }
    // Its first is the section's next meeting at a place, as standing finds it
    const { next } = standing(fall, section, calendar, now, 400)
    if (next?.place)
      expect(visits[0]?.arriveBy).toBe(next.start)
    expect(resolverOf(terms, calendar, () => now)("202610:00000")).toEqual([])
  })))

test("a week is seven days from its Monday, with the day asked among them", () =>
  fc.assert(fc.property(someFound, anInstant, (found, now) => {
    const day = localDay(now)
    const week = weekOf(found, calendar, day)
    expect(week.length).toBe(7)
    expect(weekday(week[0].day)).toBe(0)
    expect(week.map(({ day }) => day)).toContain(day)
    for (const { day, classes } of week)
      expect(classes.every(({ event }) => localDay(event.start) === day)).toBe(true)
    expect(dayStart(week[6].day) - dayStart(week[0].day)).toBeGreaterThanOrEqual(6 * DAY - 3_600_000)
  })))

test("a section's weekly lines are each pattern with days once, in the week's order: CS 518's Tuesday and Thursday in N343, then Friday in N113", () => {
  const cs518 = fall.sections.find(section => section.crn === "12496")!
  expect(patternsOf(cs518).map(({ days, where }) => `${days} ${where}`)).toEqual(["TR Kingsbury N343", "F Kingsbury N113"])
  fc.assert(fc.property(fc.constantFrom(...fall.sections), section => {
    const patterns = patternsOf(section)
    expect(patterns.every(({ days }) => days)).toBe(true)
    expect(new Set(patterns.map(({ days, start, end, where }) => `${days} ${start} ${end} ${where}`)).size).toBe(patterns.length)
  }))
})
