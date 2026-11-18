// Final exams (src/courses/finals.mts, scripts/map/finals.mts): the examinations page's links, the sheet read from an
// .xlsx as Excel writes one, its rows as each CRN's sittings and rooms, written as the term's meetings write them, and
// what's kept from night to night; read back as a section's final, its event, its conflicts, and its calendar entry

import { test, expect } from "vitest"
import fc from "fast-check"
import { type Cell, type Final, type Finals, MalformedSheet, conflicting, dayOf, downloadUrl, entryOfFinal, eventOfFinal, finalsOf, fromSheet, merged, placeOfFinal, placerFor, roomsOf, scheduleLinks, timesOf } from "../../src/courses/finals.mts"
import { clock } from "../../src/courses/course.mts"
import { sheetRows } from "../../scripts/map/finals.mts"
import { writeCalendar } from "../../src/shared/ics.mts"
import { addDays, atClock, localDay } from "../../src/shared/time.mts"
import { xlsxOf } from "../fixtures/xlsx.mts"
import { examinations, fall, fallFinals, finalsRows, names } from "./fixtures.mts"

const section = (crn: string) =>
  fall.sections.find(section => section.crn === crn)!

/** "1:05pm", as the sheet writes a time */
const said = (minutes: number) =>
  `${(Math.floor(minutes / 60) + 11) % 12 + 1}:${String(minutes % 60).padStart(2, "0")}${minutes < 720 ? "am" : "pm"}`

const HEADER: Cell[] = ["CRN", "Subject", "Crse#", "Section", "Title", "Exam Date", "Times", "Bldg", "Room"]

test("the examinations page links Fall 2026's schedule and leaves Spring 2027's, still TBA, out", () => {
  const links = scheduleLinks(examinations)
  expect(links).toEqual([{ name: "Fall 2026", url: "https://universitysystemnh.sharepoint.com/:x:/t/UNHOfficeoftheRegistrar/IQAp5iDqZ_WlRY_sr7O0MRykAYy5Zh9DhAPEmDv9VPuFEpE?e=BdhHyN" }])
  expect(new URL(downloadUrl(links[0].url)).searchParams.get("download")).toBe("1")
  expect(new URL(downloadUrl(links[0].url)).searchParams.get("e")).toBe("BdhHyN")
})

test("a sheet's times, as the registrar writes them, are the minutes said, and backwards or overnight ones aren't times", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 1438 }), fc.integer({ min: 1, max: 1439 }), fc.boolean(), (start, length, isSpaced) => {
    const end = Math.min(1439, start + length)
    expect(timesOf(`${said(start)}${isSpaced ? " - " : "-"}${said(end)}`)).toEqual(start < end ? [start, end] : undefined)
    expect(timesOf(`${said(end)}-${said(start)}`)).toBeUndefined()
  }))
)

test("an exam date is Excel's serial or the registrar's month/day/year, and anything else isn't a day", () =>
  fc.assert(fc.property(fc.integer({ min: -2000, max: 4000 }), offset => {
    const day = addDays("2026-12-15", offset)
    const serial = Math.round((Date.parse(day) - Date.parse("1899-12-30")) / 86_400_000)
    expect(dayOf(serial)).toBe(day)
    const [y, m, d] = day.split("-")
    expect(dayOf(`${+m}/${+d}/${y}`)).toBe(day)
    expect(dayOf(serial + 0.5)).toBeUndefined()
    expect(dayOf(day)).toBeUndefined()
  }))
)

/** Rows in the registrar's columns, a CRN's rooms each a row */
const aSheet = fc.uniqueArray(fc.record({
  crn:      fc.integer({ min: 10_000, max: 99_999 }).map(String),
  sittings: fc.array(fc.record({
    day:   fc.integer({ min: 0, max: 7 }).map(n => addDays("2026-12-15", n)),
    block: fc.constantFrom([480, 600], [630, 750], [780, 900], [930, 1050], [1080, 1200]),
    rooms: fc.uniqueArray(fc.constantFrom(["KING", "N343"], ["HORT", "B04"], ["MURK", "115"], ["ONLINE", ""], ["OFFCMP", ""], ["COLE", "C219"]), { minLength: 1, maxLength: 4, selector: ([code]) => code })
  }), { minLength: 1, maxLength: 2 })
}), { minLength: 1, maxLength: 12, selector: ({ crn }) => crn })

test("a sheet written as Excel writes it reads back as each CRN's sittings, soonest first, each with every room listed for it", () =>
  fc.assert(fc.property(aSheet, fc.boolean(), (crns, isShuffled) => {
    const rows: Cell[][] = crns.flatMap(({ crn, sittings }) => sittings.flatMap(({ day, block: [start, end], rooms }) =>
      rooms.map(([code, room]): Cell[] => [crn, "CS", "518", "01", "Formal Languages & Computation", Math.round((Date.parse(day) - Date.parse("1899-12-30")) / 86_400_000), `${said(start)}-${said(end)}`, code, room || undefined])))
    if (isShuffled)
      rows.reverse()
    const { finals, rows: read } = fromSheet(sheetRows(xlsxOf([HEADER, ...rows])), placerFor(names, fall.sections))
    expect(read).toBe(rows.length)
    expect(Object.keys(finals).sort()).toEqual(crns.map(({ crn }) => crn).sort())
    for (const { crn, sittings } of crns) {
      const read = finals[crn]
      for (const { day, block: [start, end], rooms } of sittings) {
        const sitting = read.find(final => final.day === day && final.start === start && final.end === end)!
        expect(sitting.rooms.length).toBeGreaterThanOrEqual(rooms.length)
      }
      expect(read.map(({ day, start }) => `${day} ${clock(start)}`)).toEqual(read.map(({ day, start }) => `${day} ${clock(start)}`).sort())
    }
  }))
)

test("the fall fixture's sheet reads as its made-up finals: each in its section's own room, a common exam in one of three, and a final in two parts", () => {
  expect(finalsRows[0]).toContain("CRN")
  // CS 518 sits its final in Kingsbury N343, written as its meetings write it, and placed
  expect(fallFinals["12496"]).toEqual([expect.objectContaining({ rooms: [{ place: "Kingsbury Hall", where: "Kingsbury N343" }] })])
  // CHEM 405's lectures share three rooms at once, which is one of them for each student
  const common = fallFinals["10114"]
  expect(common).toHaveLength(1)
  expect(roomsOf(common[0])).toBe("Horton B04, Murkland 115, Spaulding Life Science 145")
  expect(placeOfFinal(common[0])).toBeUndefined()
  expect(fallFinals["10860"]).toEqual(common)
  // CS 520 sits in two parts, the earlier first
  expect(fallFinals["11267"].map(({ day }) => day)).toEqual(["2026-12-15", "2026-12-21"])
  // Online and off campus are nowhere on the map
  expect(Object.values(fallFinals).flat().some(({ rooms }) => rooms.some(room => room.where === "Online" && !room.place))).toBe(true)
  expect(fallFinals["19998"]).toEqual([expect.objectContaining({ rooms: [{ where: "Off campus" }] })])
  // Every final is in the finals window, at one of the five blocks
  for (const final of Object.values(fallFinals).flat()) {
    expect(final.day >= "2026-12-15" && final.day <= "2026-12-22").toBe(true)
    expect([480, 630, 780, 930, 1080]).toContain(final.start)
  }
})

test("a sheet that can't be read fails, naming the row, rather than shipping half read", () => {
  const good: Cell[] = ["12496", "CS", "518", "01", "Formal Languages", 46372, "8:00am-10:00am", "KING", "N343"]
  const place = placerFor(names, fall.sections)
  expect(() => fromSheet([["Subject", "Title"], good], place)).toThrow(MalformedSheet)
  expect(() => fromSheet([HEADER.slice(0, 7), good], place)).toThrow(/no column for code/)
  expect(() => fromSheet([HEADER, good, [...good.slice(0, 5), "Dec 16", ...good.slice(6)]], place)).toThrow(/Row 3 \(CRN 12496\)/)
  expect(() => fromSheet([HEADER, [...good.slice(0, 6), "TBA", ...good.slice(7)]], place)).toThrow(/Row 2/)
})

test("a building code the table lacks keeps its room as written and nowhere, and is told", () => {
  const unknown: string[] = []
  const place = placerFor(names, fall.sections, error => void unknown.push(error.code))
  expect(place("NEWBLD", "101")).toEqual({ where: "NEWBLD 101" })
  expect(unknown).toEqual(["NEWBLD"])
  // A building the map knows that no class of the term meets in is written by its name on the map
  expect(placerFor(names, []).call(undefined, "KING", "N343")).toEqual({ place: "Kingsbury Hall", where: "Kingsbury Hall N343" })
})

/** Finals as stored, of some terms, each on a day */
const stored = (terms: Record<string, string>): Finals => ({
  version: 1,
  through: "2026-11-18",
  terms:   Object.fromEntries(Object.entries(terms).map(([code, day]) => [code, { name: code, source: "", fetched: 0, finals: { "12496": [{ day, start: 480, end: 600, rooms: [] }] } }]))
})

test("a night's read replaces the terms it read, and keeps another stored till its finals are a week over", () =>
  fc.assert(fc.property(fc.integer({ min: -30, max: 30 }), late => {
    const today = "2026-12-20"
    const before = stored({ "202610": addDays(today, late), "202650": "2027-05-12" })
    const read = stored({ "202650": "2027-05-13" }).terms
    const after = merged(before, read, today)
    expect(after.through).toBe(today)
    expect(after.terms["202650"]).toBe(read["202650"])
    expect("202610" in after.terms).toBe(late >= -7)
    expect(merged(undefined, read, today).terms).toEqual(read)
  }))
)

test("a section's final is its own, else a section's it's cross-listed with, else none", () => {
  const listed = fall.sections.find(section => section.crossListed.length && !fallFinals[section.crn] && section.crossListed.some(crn => fallFinals[crn]))
  for (const one of fall.sections)
    expect(finalsOf(fallFinals, one)).toEqual(fallFinals[one.crn] ?? one.crossListed.map(crn => fallFinals[crn]).find(Boolean) ?? [])
  if (listed)
    expect(finalsOf(fallFinals, listed).length).toBeGreaterThan(0)
  expect(finalsOf(undefined, section("12496"))).toEqual([])
})

test("a final is an event on its day at its time in Durham, placed where it's in one building, with a page to go to", () =>
  fc.assert(fc.property(fc.constantFrom(...Object.keys(fallFinals).filter(crn => fall.sections.some(section => section.crn === crn))), crn => {
    for (const final of fallFinals[crn]) {
      const event = eventOfFinal(fall, section(crn), final)
      expect(localDay(event.start)).toBe(final.day)
      expect(event.start).toBe(atClock(final.day, clock(final.start)))
      expect(event.end).toBe(atClock(final.day, clock(final.end)))
      expect(event.place).toBe(placeOfFinal(final))
      expect(event.url).toBe(`/map/section/202610/${crn}`)
    }
  }))
)

test("finals conflict where two sections' sittings overlap on a day, never a section's with itself", () =>
  fc.assert(fc.property(fc.array(fc.record({ crn: fc.constantFrom("10001", "10002", "10003"), day: fc.constantFrom("2026-12-15", "2026-12-16"), start: fc.integer({ min: 480, max: 1200 }), length: fc.integer({ min: 30, max: 180 }) }), { maxLength: 6 }), list => {
    const sittings = list.map(({ crn, day, start, length }) => ({ crn, final: { day, start, end: start + length, rooms: [] } satisfies Final }))
    const found = conflicting(sittings)
    for (const one of sittings)
      expect(found.has(one)).toBe(sittings.some(other => other.crn !== one.crn && other.final.day === one.final.day && other.final.start < one.final.end && one.final.start < other.final.end))
  }))
)

test("each sitting of a final is a calendar entry of its own, named for good by its section and which sitting it is, its rooms said as one of", () => {
  const ics = writeCalendar("notunh", [...fallFinals["11267"].map((final, i) => entryOfFinal(fall, section("11267"), final, i)), entryOfFinal(fall, section("10114"), fallFinals["10114"][0])], 0).replace(/\r\n /g, "")
  expect(ics).toContain("UID:course-202610-11267-final@notunh.app")
  expect(ics).toContain("UID:course-202610-11267-final-2@notunh.app")
  expect(ics).toContain("DTSTART;TZID=America/New_York:20261215T180000")
  expect(ics).toContain("LOCATION:Horton B04 or Murkland 115 or Spaulding Life Science 145")
  expect(ics).toContain("a common final\\, in one of its rooms")
  expect(ics.slice(ics.indexOf("BEGIN:VEVENT"))).not.toContain("RRULE")
})
