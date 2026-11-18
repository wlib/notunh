// The finals' fixtures (tests/fixtures/courses/): the examinations page cut to its schedules, Fall 2026's linked and
// Spring 2027's "TBA", as the registrar has them; and a Final Exam Schedule in the registrar's own columns, made up for
// the fall fixture's sections, so no real exam's time or room is kept here. Each lecture with a room has its final in
// that room on one of the finals' days at one of the five blocks, by its place in the fixture; CHEM 405's lectures sit
// a common exam in three rooms; CS 520's sits in two parts; an online lecture's is ONLINE; and two CRNs no fixture
// section has are off campus, as the sheet lists every campus. Written by make.mts, or run alone

import { readFile, writeFile } from "node:fs/promises"
import * as v from "valibot"
import type { Cell } from "../../src/courses/finals.mts"
import { Page } from "../../src/courses/registrar.mts"
import { addDays, daysBetween } from "../../src/shared/time.mts"
import { xlsxOf } from "./xlsx.mts"

/** The day most of the fixture's finals are counted from, in finals of the 15th to the 22nd, and the five blocks */
const FIRST = "2026-12-16"
const BLOCKS = ["8:00am-10:00am", "10:30am-12:30pm", "1:00pm-3:00pm", "3:30pm-5:30pm", "6:00pm-8:00pm"]

/** A day as Excel counts it */
const serialOf = (day: string) =>
  daysBetween("1899-12-30", day)

const HEADER: Cell[] = ["CRN", "Subject", "Crse#", "Section", "Title", "Exam Date", "Times", "Bldg", "Room", "To filter by any header category, click the drop down arrow and check the items to display. "]

/** The sheet's rows for the fall fixture's answer */
export const finalsRows = (page: Page): Cell[][] => {
  const rows: Cell[][] = [HEADER]
  type Course = { SYVSCHD_CRN: string, SYVSCHD_SUBJ_CODE: string, SYVSCHD_CRSE_NUMB: string, SYVSCHD_SEQ_NUMB: string, SYVSCHD_CRSE_LONG_TITLE: string, SYVSCHD_SCHD_CODE: string, SYVSCHD_INSM_CODE: string, MEETINGS: { BUILDING: string, ROOM: string, DAYS: string }[] }
  const courses = page.data.map(row => (row as { COURSE_DATA: Course }).COURSE_DATA)
  const row = (c: Course, day: string, block: string, code: string, room: string): Cell[] =>
    [c.SYVSCHD_CRN, c.SYVSCHD_SUBJ_CODE, c.SYVSCHD_CRSE_NUMB, c.SYVSCHD_SEQ_NUMB, c.SYVSCHD_CRSE_LONG_TITLE.trim(), serialOf(day), block, code, room]
  let online = false
  for (const [i, c] of courses.entries()) {
    const met = c.MEETINGS.find(meeting => meeting.DAYS && meeting.BUILDING !== "TBA")
    const course = `${c.SYVSCHD_SUBJ_CODE} ${c.SYVSCHD_CRSE_NUMB}`
    if (!/^(LEC|CLL)$/.test(c.SYVSCHD_SCHD_CODE) || !met)
      continue
    if (course === "CHEM 405")
      rows.push(...[["HORT", "B04"], ["MURK", "115"], ["SLS", "145"]].map(([code, room]) => row(c, "2026-12-17", BLOCKS[3], code, room)))
    else if (course === "CS 520")
      rows.push(row(c, "2026-12-15", BLOCKS[4], met.BUILDING, met.ROOM), row(c, "2026-12-21", BLOCKS[0], "KING", "N101"))
    else if (!online && (met.BUILDING === "ONLINE" || c.SYVSCHD_INSM_CODE === "ONLS")) {
      online = true
      rows.push(row(c, addDays(FIRST, i % 6), BLOCKS[i % 5], "ONLINE", ""))
    }
    else
      rows.push(row(c, addDays(FIRST, i % 6), BLOCKS[i % 5], met.BUILDING, met.ROOM))
  }
  const elsewhere = { SYVSCHD_SUBJ_CODE: "NR", SYVSCHD_CRSE_NUMB: "797", SYVSCHD_CRSE_LONG_TITLE: "Field Methods", MEETINGS: [], SYVSCHD_SCHD_CODE: "LEC", SYVSCHD_INSM_CODE: "IPFF" }
  rows.push(row({ ...elsewhere, SYVSCHD_CRN: "19998", SYVSCHD_SEQ_NUMB: "01" }, "2026-12-18", BLOCKS[1], "OFFCMP", ""))
  rows.push(row({ ...elsewhere, SYVSCHD_CRN: "19999", SYVSCHD_SEQ_NUMB: "02" }, "2026-12-18", BLOCKS[1], "OFFCMP", ""))
  return rows
}

/** Where the sheet's kept */
export const SHEET = new URL("courses/finals-202610.xlsx", import.meta.url)

export const writeFinalsSheet = async () => {
  const page = v.parse(Page, JSON.parse(await readFile(new URL("courses/courses-202610.json", import.meta.url), "utf8")))
  await writeFile(SHEET, xlsxOf(finalsRows(page)))
}

if (import.meta.main)
  await writeFinalsSheet()
