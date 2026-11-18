// What the courses' tests read: trimmed copies of the registrar's answers for Fall 2026, J-Term 2027 and Spring 2027
// (tests/fixtures/courses/, the subjects CS, IT, CEE, PSYC, DS, NURS and CHEM in fall and fewer in spring, with the
// sections cross-listed with them, every row cut to the fields the import reads and every address made up), and
// 25Live's academic calendar over the year, all imported here as scripts/map/courses.mts imports them; and the
// examinations page and a Final Exam Schedule made up for the fall sections (tests/fixtures/finals.mts), read as
// scripts/map/finals.mts reads them

import { readFile } from "node:fs/promises"
// Node's URL, which its fs functions take, rather than whatever global URL the typecheck sees
import { URL } from "node:url"
import fc from "fast-check"
import * as v from "valibot"
import { fromLive25 } from "../../src/courses/calendar.mts"
import { type Term, clock, termSpan } from "../../src/courses/course.mts"
import { placeOfCode } from "../../src/courses/buildings.mts"
import { Page, importTerm, pageRead } from "../../src/courses/registrar.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { addDays } from "../../src/shared/time.mts"
import { fromSheet, placerFor } from "../../src/courses/finals.mts"
import { sheetRows } from "../../scripts/map/finals.mts"

const read = async (path: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as unknown

const gazetteer = v.parse(Gazetteer, await read("data/src/map/gazetteer.json"))
export const names = new Set(gazetteer.places.map(({ name }) => name))
export const place = placeOfCode(names)

export const live25 = await read("courses/25live.json") as unknown[]
export const calendar = fromLive25(live25, 0)

/** A term's answer, as the pages of a hundred rows the API gives */
export const pagesOf = (page: Page) =>
  Array.from({ length: Math.ceil(page.data.length / 100) }, (_, i) => pageRead({ ...page, data: page.data.slice(i * 100, i * 100 + 100) }, 0))

export const rawPages = Object.fromEntries(await Promise.all(["202610", "202630", "202650"].map(async code => [code, v.parse(Page, await read(`courses/courses-${code}.json`))] as const)))

const termOf = async (code: string): Promise<Term> => {
  const term = await importTerm(code, pagesOf(rawPages[code]), place)
  return { ...term, ...termSpan(code, calendar, term.sections), built: term.fetched + 1 }
}

export const fall   = await termOf("202610")
export const jterm  = await termOf("202630")
export const spring = await termOf("202650")
export const rawRows = rawPages["202610"].data

/** A day from just before the fall term to just after it, and a time of day */
export const aDay = fc.integer({ min: -10, max: 130 }).map(offset => addDays(fall.from, offset))
export const aClock = fc.integer({ min: 0, max: 1439 }).map(clock)


/** The examinations page, cut to its schedules */
export const examinations = await readFile(new URL("../fixtures/courses/examinations.html", import.meta.url), "utf8")

/** The fall fixture's Final Exam Schedule, its rows, and its finals placed with the fall term's sections */
export const finalsSheet = new Uint8Array(await readFile(new URL("../fixtures/courses/finals-202610.xlsx", import.meta.url)))
export const finalsRows = sheetRows(finalsSheet)
export const fallFinals = fromSheet(finalsRows, placerFor(names, fall.sections)).finals
