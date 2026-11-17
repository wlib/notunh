import { test, expect } from "vitest"
import fc from "fast-check"
import { type Season, LETTERS, fromLive25, letters, meetingRule, termCode, termName } from "../../src/courses/calendar.mts"
import { occurs } from "../../src/shared/recur.mts"
import { day } from "../shared/rules.mts"
import { calendar, live25 } from "./fixtures.mts"

test("the calendar read from 25Live has the holidays, the swap day, the terms' dates and finals, and only all-day academic entries", () => {
  for (const day of ["2026-09-07", "2026-10-12", "2026-11-11", "2026-11-25", "2026-11-26", "2026-11-27", "2027-03-24"])
    expect(calendar.noClass).toContain(day)
  expect(calendar.holidays).toEqual(["2026-09-07", "2026-11-11", "2027-01-01", "2027-01-18", "2027-05-31"])
  expect(calendar.swaps).toEqual({ "2026-10-13": "W" })
  expect(calendar.terms["202610"]).toEqual({ name: "Fall 2026", start: "2026-08-31", end: "2026-12-14", finals: ["2026-12-15", "2026-12-22"], reading: ["2026-12-15"] })
  expect(calendar.terms["202650"]).toMatchObject({ start: "2027-01-26", end: "2027-05-10", finals: ["2027-05-12", "2027-05-18"] })
  // Indigenous Peoples Day isn't a UNH holiday, though classes don't meet
  expect(calendar.holidays).not.toContain("2026-10-12")
  // Nothing timed, and nothing from another calendar, says a day is off
  const entries = live25 as { startDateTime: string, allDay?: boolean, categoryCalendar?: string }[]
  const academic = (entry: typeof entries[number]) => entry.allDay && /Academic Calendar$|Holidays$/.test(entry.categoryCalendar ?? "")
  expect(fromLive25(entries.filter(entry => !academic(entry)), 0)).toEqual({ fetched: 0, noClass: [], swaps: {}, holidays: [], terms: {}, dates: [] })
  // A window of a month says only what's in it
  expect(fromLive25(entries.filter(entry => entry.startDateTime.startsWith("2026-11-1")), 0).noClass).toEqual(["2026-11-11"])
})

test("the dates worth knowing ahead are Durham undergraduates' deadlines, registration, breaks and terms, by day, in the registrar's words less its capitals, a window by who it's for", () => {
  const dates = calendar.dates
  expect(dates.map(({ day }) => day)).toEqual(dates.map(({ day }) => day).sort())
  expect(dates).toContainEqual({ day: "2026-11-26", title: "Thanksgiving Holidays", kind: "break" })
  expect(dates).toContainEqual({ day: "2026-12-14", title: "Fall 2026 Last Day of Classes", kind: "term" })
  // A registration window says who it's for first, its term and time after
  expect(dates.find(({ day, kind }) => day === "2026-11-23" && kind === "registration")).toEqual({ day: "2026-11-23", kind: "registration", title: "Seniors · registration opens", audience: "senior", detail: "Spring 2027 · 8:30am" })
  expect(dates.filter(({ kind, audience }) => kind === "registration" && audience).map(({ audience }) => audience)).toEqual(expect.arrayContaining(["senior", "junior", "sophomore", "first-year"]))
  expect(dates.some(({ title }) => /undergraduate coursework/i.test(title))).toBe(true)
  expect(dates.some(({ title }) => /UNH Law|CPS Online|Faculty|\bgraduate\b/i.test(title))).toBe(false)
})

test("an entry of a shape not known is left out, and the same entry twice counts once", () => {
  const doubled = fromLive25([...live25, ...live25, { title: 3 }, null], 7)
  expect(doubled).toEqual({ ...calendar, fetched: 7 })
})

test("term codes follow the academic year, Fall 2026, J-Term 2027 and Spring 2027 sharing 2026, and names read back", () => {
  expect(termCode("Fall", 2026)).toBe("202610")
  expect(termCode("J-Term", 2027)).toBe("202630")
  expect(termCode("Spring", 2027)).toBe("202650")
  expect(termCode("Summer", 2027)).toBe("202670")
  fc.assert(fc.property(fc.integer({ min: 2020, max: 2040 }), fc.constantFrom<Season>("Fall", "J-Term", "Spring", "Summer"), (year, season) => {
    expect(termName(termCode(season, year))).toBe(`${season} ${year}`)
  }))
})

test("classes on some weekdays meet on those, and on a day swapped to one of them, but never a day swapped to another or a day without classes", () => {
  const offsets = fc.uniqueArray(fc.integer({ min: 0, max: 120 }), { maxLength: 12 })
  fc.assert(fc.property(day, fc.subarray([...LETTERS]), offsets, offsets, fc.array(fc.constantFrom(...LETTERS), { minLength: 12, maxLength: 12 }), (start, meets, off, swapped, to) => {
    const calendar = { noClass: off.map(days => start.add({ days }).toString()), swaps: Object.fromEntries(swapped.map((days, i) => [start.add({ days }).toString(), to[i]])) }
    const rule = meetingRule(calendar, meets.join(""))
    for (let i = 0, at = start; i <= 120; i++, at = at.add({ days: 1 })) {
      const follows = calendar.swaps[at.toString()] ?? LETTERS[at.dayOfWeek - 1]
      expect(occurs(rule, at)).toBe(meets.includes(follows) && !calendar.noClass.includes(at.toString()))
    }
    // Asked again of the same calendar and weekdays, it's the rule made before
    expect(meetingRule(calendar, meets.join(""))).toBe(rule)
  }))
})

test("a registrar's days read as the letters in them", () => {
  expect(letters("MWF")).toEqual(["M", "W", "F"])
  expect(letters("")).toEqual([])
})
