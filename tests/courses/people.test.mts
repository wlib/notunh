import { test, expect } from "vitest"
import fc from "fast-check"
import { createPeople, nextTeaching, upcoming } from "../../src/courses/people.mts"
import { createCourseSearch } from "../../src/courses/search.mts"
import { activeTerms, occurrences, standing } from "../../src/courses/course.mts"
import { addDays, atClock, localDay } from "../../src/shared/time.mts"
import { aClock, aDay, calendar, fall, jterm, spring } from "./fixtures.mts"

const terms = [fall, jterm, spring]
const people = createPeople(terms)
const teaching = people.filter(person => person.teaching.some(({ term, section }) => term === fall && section.meetings.some(meeting => meeting.days)))
const aPerson = fc.constantFrom(...teaching)

test("a person is a hidden address where the registrar gives one, so two instructors of one name are two people, each with their own teaching", () => {
  const wangs = people.filter(person => person.name === "Jing Wang")
  expect(wangs.length).toBe(2)
  expect(new Set(wangs.map(person => person.mail)).size).toBe(2)
  expect(wangs.every(person => person.id === person.mail)).toBe(true)
  const subjects = wangs.map(person => new Set(person.teaching.map(({ section }) => section.subject)))
  expect([...subjects[0]].some(subject => subjects[1].has(subject))).toBe(false)
  // Nobody is counted twice, and everyone listed on a section is someone
  expect(people.length).toBe(new Set(terms.flatMap(term => term.sections.flatMap(section => section.instructors.map(({ name, mail }) => mail ?? name)))).size)
})

test("a person's next class is the soonest start across every section they teach in a live term, whatever the order of sections or meetings", () =>
  fc.assert(fc.property(aPerson, aDay, aClock, (person, day, time) => {
    const now = atClock(day, time)
    const { current, next } = nextTeaching(person, calendar, now)
    const live = person.teaching.filter(({ term }) => activeTerms([term], now).length)
    const all = live.flatMap(({ term, section }) => Array.from({ length: 21 }, (_, i) => occurrences(term, section, calendar, addDays(day, i))).flat())
      .sort((a, b) => a.start - b.start || a.crn.localeCompare(b.crn))
    expect(next?.id).toBe(all.find(event => event.start > now)?.id)
    expect(current?.id).toBe(all.find(event => event.start <= now && now < event.end)?.id)
    if (next)
      expect(next.section.instructors.some(({ name }) => name === person.name)).toBe(true)
    const reversed = { ...person, teaching: person.teaching.toReversed().map(({ term, section }) => ({ term, section: { ...section, meetings: section.meetings.toReversed() } })) }
    expect(nextTeaching(reversed, calendar, now).next?.id).toBe(next?.id)
  }))
)

test("teaching in a later term never outranks today's class: in the fall a person's next class is in fall, never spring", () =>
  fc.assert(fc.property(aPerson, aDay.filter(day => day < "2026-12-01"), aClock, (person, day, time) => {
    const { next } = nextTeaching(person, calendar, atClock(day, time))
    if (next)
      expect(next.term).toBe("202610")
  }))
)

test("David Benedetto's next class on Tuesday 27 October at 1:40 is CS 518 at 2:10 in Kingsbury N343, and on Friday it's N113", () => {
  const benedetto = people.find(person => person.name === "David Benedetto")!
  const tuesday = nextTeaching(benedetto, calendar, atClock("2026-10-27", "13:40"))
  expect(tuesday.current).toBeUndefined()
  expect(tuesday.next).toMatchObject({ where: "Kingsbury N343", crn: "12496" })
  expect(localDay(tuesday.next!.start)).toBe("2026-10-27")
  // He also teaches IT 791 on Monday and Wednesday and CS 450 on Tuesday and Thursday mornings, so the whole week matters
  const during = nextTeaching(benedetto, calendar, atClock("2026-10-27", "14:30"))
  expect(during.current).toMatchObject({ where: "Kingsbury N343" })
  expect(during.next).toMatchObject({ where: "Kingsbury S320", crn: "12286" })
  expect(localDay(during.next!.start)).toBe("2026-10-28")
  expect(nextTeaching(benedetto, calendar, atClock("2026-10-27", "08:00")).next).toMatchObject({ where: "Pettee Hall 114", crn: "16012" })
  expect(nextTeaching(benedetto, calendar, atClock("2026-10-30", "08:00")).next).toMatchObject({ where: "Kingsbury N113" })
  expect(upcoming(benedetto, calendar, atClock("2026-10-27", "13:40")).map(({ section }) => section.crn)).toContain("12496")
})

test("searching a name finds the person, with their sections under them, and two of one name as two", () => {
  const search = createCourseSearch([fall], people)
  const found = search("Benedetto")
  expect(found.people.map(person => person.name)).toContain("David Benedetto")
  expect(found.people.find(person => person.name === "David Benedetto")!.teaching.map(({ section }) => section.crn)).toContain("12496")
  expect(search("Jing Wang").people.filter(person => person.name === "Jing Wang").length).toBe(2)
})

test("every person's upcoming list is sorted by their next start and covers every live section with a meeting left", () =>
  fc.assert(fc.property(aPerson, aDay, (person, day) => {
    const now = atClock(day, "08:00")
    const list = upcoming(person, calendar, now)
    for (let i = 1; i < list.length; i++)
      expect((list[i].current ?? list[i].next)!.start).toBeGreaterThanOrEqual((list[i - 1].current ?? list[i - 1].next)!.start)
    const expected = person.teaching.filter(({ term, section }) => {
      const { current, next } = standing(term, section, calendar, now)
      return activeTerms([term], now).length && (current || next)
    })
    expect(list.length).toBe(expected.length)
  }), { numRuns: 60 })
)
