import { test, expect } from "vitest"
import fc from "fast-check"
import { MalformedRow, fromDhub, importTerm, pageRead, parseTime } from "../../src/courses/registrar.mts"
import { CODES, UnknownBuilding, placeOfCode } from "../../src/courses/buildings.mts"
import { place, rawPages, rawRows } from "./fixtures.mts"

const nowhere = () => undefined

/** Rows as one page, with the API's own total */
const pages = (rows: readonly unknown[], total = rows.length, fetched = 1) =>
  [{ rows, total, fetched }]

test("a row the schema doesn't read fails the import, naming the row and the field, rather than vanishing from the term", () => {
  expect(fromDhub(rawRows, nowhere).length).toBe(rawRows.length)
  fc.assert(fc.property(fc.integer({ min: 0, max: rawRows.length - 1 }), fc.constantFrom("SYVSCHD_CRN", "MEETINGS", "INSTRUCTORS", "SYVSCHD_SUBJ_CODE", "CROSS_LISTED"), fc.nat(500), (index, field, first) => {
    const broken = structuredClone(rawRows) as { COURSE_DATA: Record<string, unknown> }[]
    delete broken[index].COURSE_DATA[field]
    expect(() => fromDhub(broken, nowhere, first)).toThrow(MalformedRow)
    expect(() => fromDhub(broken, nowhere, first)).toThrow(new RegExp(`^Row ${first + index}\\b.*COURSE_DATA\\.${field}`))
  }), { numRuns: 30 })
  // A row of the right shape whose values aren't, like a CRN of four digits, fails the same way
  const short = structuredClone(rawRows) as { COURSE_DATA: Record<string, unknown> }[]
  short[3].COURSE_DATA.SYVSCHD_CRN = "1234"
  expect(() => fromDhub(short, nowhere)).toThrow(/^Row 3 \(CRN 1234\).*crn/)
})

test("a term whose rows don't add up to the API's total is refused, and one that does is stamped with its oldest page's time", async () => {
  await expect(importTerm("202610", pages(rawRows, rawRows.length + 1), nowhere)).rejects.toThrow(new RegExp(`read ${rawRows.length} sections but the API says ${rawRows.length + 1}`))
  await expect(importTerm("202610", [{ rows: rawRows.slice(0, 10), total: 20, fetched: 1 }, { rows: rawRows.slice(10, 20), total: 21, fetched: 2 }], nowhere)).rejects.toThrow(/total changed/)
  const term = await importTerm("202610", [{ rows: rawRows.slice(0, 10), total: 20, fetched: 1234 }, { rows: rawRows.slice(10, 20), total: 20, fetched: 99 }], nowhere)
  expect(term).toMatchObject({ code: "202610", name: "Fall 2026", fetched: 99 })
  expect(term.sections.length).toBe(20)
})

test("a CRN appearing twice is refused", async () => {
  await expect(importTerm("202610", pages([rawRows[0], rawRows[1], rawRows[0]]), nowhere)).rejects.toThrow(/CRN \d{5} appears twice/)
})

test("a page's time is the API's own clock where it says, else when it was read", () => {
  const page = rawPages["202610"]
  expect(pageRead(page, 5).fetched).toBe(Date.parse(page.timestamp!))
  expect(pageRead({ ...page, timestamp: undefined }, 5).fetched).toBe(5)
})

test("every building code in the fixtures is in the table, and one the table can't place fails the import", () => {
  const codes = new Set(Object.values(rawPages).flatMap(page => page.data.flatMap(row => (row as { COURSE_DATA: { MEETINGS: { BUILDING: string }[] } }).COURSE_DATA.MEETINGS.map(meeting => meeting.BUILDING))))
  for (const code of codes)
    expect(code in CODES).toBe(true)
  // Every name in the table is one the gazetteer has
  for (const code of Object.keys(CODES))
    expect(() => place(code, "")).not.toThrow()
  const known = placeOfCode(new Set(["Kingsbury Hall"]))
  expect(known("KING", "Kingsbury")).toBe("Kingsbury Hall")
  expect(known("TBA", "")).toBeUndefined()
  expect(() => known("NEWBLDG", "New Building")).toThrow(UnknownBuilding)
  expect(() => known("HS", "Hamilton Smith")).toThrow(/gazetteer doesn't name/)
  const unknown = structuredClone(rawRows) as { COURSE_DATA: { MEETINGS: { BUILDING: string }[] } }[]
  const row = unknown.find(row => row.COURSE_DATA.MEETINGS.length)!
  row.COURSE_DATA.MEETINGS[0].BUILDING = "NEWBLDG"
  expect(() => fromDhub(unknown, place)).toThrow(UnknownBuilding)
})

test("a placer told of the codes it can't place puts them nowhere, never somewhere, and places the rest as ever", () => {
  const names = Object.values(CODES).filter(name => name !== null)
  const code = fc.oneof(fc.constantFrom(...Object.keys(CODES)), fc.string(), fc.constantFrom("constructor", "toString", "__proto__"))
  fc.assert(fc.property(code, fc.string(), fc.subarray(names), (code, description, kept) => {
    const told: string[] = []
    const placed = placeOfCode(new Set(kept), error => void told.push(error.code))(code, description)
    const name = Object.hasOwn(CODES, code) ? CODES[code] : undefined
    const isPlaceable = name === null || (name !== undefined && kept.includes(name))
    expect(placed).toBe(isPlaceable ? name ?? undefined : undefined)
    expect(told).toEqual(isPlaceable ? [] : [code])
    if (!isPlaceable)
      expect(() => placeOfCode(new Set(kept))(code, description)).toThrow(UnknownBuilding)
  }))
})

test("a meeting whose building can't be placed keeps its text", () => {
  const rows = structuredClone(rawRows) as { COURSE_DATA: { MEETINGS: { BUILDING: string, BUILDING_DESC: string, ROOM: string }[] } }[]
  const at = rows.findIndex(row => row.COURSE_DATA.MEETINGS.length)
  Object.assign(rows[at].COURSE_DATA.MEETINGS[0], { BUILDING: "NEWBLDG", BUILDING_DESC: "New Building", ROOM: "101" })
  const told: string[] = []
  const [meeting] = fromDhub(rows, placeOfCode(new Set(), error => void told.push(error.code)))[at].meetings
  expect(meeting).toMatchObject({ where: "New Building 101" })
  expect(meeting).not.toHaveProperty("place")
  expect(told).toContain("NEWBLDG")
})

test("registrar times read as minutes after midnight, round the clock, and hours arranged as none", () => {
  expect(parseTime("Hours Arranged")).toBeUndefined()
  fc.assert(fc.property(fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 0, max: 1439 }), (a, b) => {
    const time = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")}${m < 720 ? "am" : "pm"}`
    expect(parseTime(`${time(a)} - ${time(b)}`)).toEqual([a, b])
  }))
})
