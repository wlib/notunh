import { test, expect } from "vitest"
import fc from "fast-check"
import { LINE, fold, icsOf, utc } from "../../src/courses/ics.mts"
import { type Section, meetingKeys, occurrences } from "../../src/courses/course.mts"
import { addDays, atClock, weekday } from "../../src/shared/time.mts"
import { calendar, fall, spring } from "./fixtures.mts"

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
const octets = (text: string) => new TextEncoder().encode(text).length

/** The VEVENTs of a file, each as its properties, lines unfolded */
const vevents = (ics: string) =>
  ics.replace(/\r\n /g, "").split("\r\n").reduce<Record<string, string[]>[]>((events, line) => {
    const [, name, value] = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/) ?? []
    if (name === "BEGIN" && value === "VEVENT")
      events.push({})
    else if (name && events.length && !("END" in events.at(-1)!))
      (events.at(-1)![name] ??= []).push(value)
    return events
  }, [])

/** The days a weekly rule with EXDATEs and RDATEs lands on, as a calendar app computes them, UNTIL read as the UTC instant it is */
const expand = (event: Record<string, string[]>) => {
  const start = event.DTSTART[0]
  const day = (stamp: string) => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
  const until = Date.parse(event.RRULE[0].match(/UNTIL=(\d{8}T\d{6}Z)/)![1].replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, "$1-$2-$3T$4:$5:$6Z"))
  const days = event.RRULE[0].match(/BYDAY=([A-Z,]+)/)![1].split(",").map(code => BYDAY.indexOf(code))
  const time = `${start.slice(9, 11)}:${start.slice(11, 13)}`
  const out = new Set<string>()
  for (let d = day(start); atClock(d, time) <= until; d = addDays(d, 1))
    if (days.includes(weekday(d)))
      out.add(d)
  for (const ex of event.EXDATE ?? [])
    out.delete(day(ex))
  for (const extra of event.RDATE ?? [])
    out.add(day(extra))
  return [...out].sort()
}

const timed = fall.sections.filter(section => section.meetings.some(meeting => meeting.days))
const saved = (sections: readonly Section[]) => sections.map(section => ({ term: fall, section }))

test("a calendar app expanding the file's rules, UNTIL as the UTC instant it is, lands on exactly the days the app shows the class, swap day and holidays included", () =>
  fc.assert(fc.property(fc.uniqueArray(fc.constantFrom(...timed), { minLength: 1, maxLength: 6, selector: section => section.crn }), sections => {
    const events = vevents(icsOf(saved(sections), calendar))
    expect(events.length).toBe(sections.reduce((n, section) => n + section.meetings.filter(meeting => meeting.days).length, 0))
    for (const event of events) {
      const [, crn, key] = event.UID[0].match(/^course-202610-(\d{5})-(.+)@notunh\.app$/)!
      const section = sections.find(section => section.crn === crn)!
      const meeting = section.meetings[meetingKeys(section).indexOf(key)]
      const shown: string[] = []
      for (let day = meeting.from; day <= meeting.to; day = addDays(day, 1))
        if (occurrences(fall, section, calendar, day).some(event => event.key === key))
          shown.push(day)
      expect(expand(event)).toEqual(shown)
      expect(event.LOCATION[0]).toBe(meeting.where.replace(/,/g, "\\,"))
    }
  }), { numRuns: 40 })
)

test("every VEVENT has a DTSTAMP in UTC, and a TZID start goes with a UTC UNTIL, as RFC 5545 requires", () => {
  const now = Date.now()
  const ics = icsOf(saved(timed.slice(0, 10)), calendar, now)
  for (const event of vevents(ics)) {
    expect(event.DTSTAMP).toEqual([utc(now)])
    expect(event.DTSTAMP[0]).toMatch(/^\d{8}T\d{6}Z$/)
    expect(event.RRULE[0]).toMatch(/UNTIL=\d{8}T\d{6}Z/)
  }
  expect(ics).toMatch(/DTSTART;TZID=America\/New_York:\d{8}T\d{6}\r\n/)
  fc.assert(fc.property(fc.date({ min: new Date(2000, 0, 1), max: new Date(2100, 0, 1), noInvalidDate: true }), date => {
    expect(Date.parse(utc(date.getTime()).replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, "$1-$2-$3T$4:$5:$6Z"))).toBe(Math.floor(date.getTime() / 1000) * 1000)
  }))
})

test("lines fold at 75 octets of UTF-8, never 75 characters, so an accented or emoji title can't make an overlong line", () => {
  fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), text => {
    const line = `SUMMARY:${text.replace(/[\r\n]/g, " ")}`
    const folded = fold(line)
    for (const physical of folded.split("\r\n"))
      expect(octets(physical)).toBeLessThanOrEqual(LINE)
    expect(folded.replace(/\r\n /g, "")).toBe(line)
  }))
  const accented: Section = { ...timed[0], title: "Álgebra avanzada: señales, música y más — ñandú éèê ".repeat(3), instructors: [{ name: "Diego Aristizábal" }] }
  const ics = icsOf(saved([accented]), calendar)
  for (const line of ics.split("\r\n"))
    expect(octets(line)).toBeLessThanOrEqual(LINE)
  expect(ics.replace(/\r\n /g, "")).toContain("Diego Aristizábal")
})

test("the file begins and ends as RFC 5545 says, carries the time zone, and is named for its terms", () => {
  const ics = icsOf([...saved(timed.slice(0, 5)), { term: spring, section: spring.sections[0] }], calendar)
  expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true)
  expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true)
  expect(ics).toContain("TZID:America/New_York")
  expect(ics).toContain("X-WR-CALNAME:UNH Fall 2026\\, Spring 2027")
})

test("the swap day shows up as an RDATE on Wednesday classes and an EXDATE on Tuesday ones, and Thanksgiving as an EXDATE", () => {
  const tuesday = timed.find(section => section.meetings.some(meeting => meeting.days === "TR" && meeting.from <= "2026-10-13" && "2026-10-13" <= meeting.to))!
  const wednesday = timed.find(section => section.meetings.some(meeting => meeting.days === "MWF" && meeting.from <= "2026-10-13" && "2026-10-13" <= meeting.to))!
  expect(icsOf(saved([tuesday]), calendar)).toMatch(/EXDATE;TZID=America\/New_York:20261013T/)
  expect(icsOf(saved([wednesday]), calendar)).toMatch(/RDATE;TZID=America\/New_York:20261013T/)
  expect(icsOf(saved([wednesday]), calendar)).toMatch(/EXDATE;TZID=America\/New_York:20261127T/)
})
