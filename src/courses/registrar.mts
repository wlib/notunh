// The registrar's course API (courses.unh.edu's own JSON) read into sections (course.mts). Pure, so
// scripts/map/courses.mts fetches and the tests read fixtures. Unlike the event calendars, the import fails loud: a
// row the schema doesn't read throws, naming the row and the field, and a term whose rows don't add up to the API's
// own total, or that lists a CRN twice, is refused, so a change upstream can't ship a partial term. In-person
// meetings are placed on the gazetteer by building code (buildings.mts); instructors keep their name and a hidden
// address (email.mts), and usernames are dropped

import * as v from "valibot"
import { type Section, Section as SectionSchema } from "./course.mts"
import { hide } from "./email.mts"
import { termName } from "./calendar.mts"

/** A term's sections at Durham (campus 1), a page at a time */
export const coursesUrl = (term: string, offset: number, limit: number) =>
  `https://wapi.unh.edu/dhub/api/courses/all/${term}?campus=1&page[offset]=${offset}&page[limit]=${limit}`

/** A page as the API answers it: the term's total, its own clock, and the rows */
export const Page = v.object({
  "total-count": v.number(),
  timestamp:     v.optional(v.pipe(v.string(), v.isoTimestamp())),
  data:          v.array(v.unknown())
})
export type Page = v.InferOutput<typeof Page>

const Row = v.object({
  COURSE_DATA: v.object({
    SYVSCHD_CRN:             v.string(),
    SYVSCHD_SUBJ_CODE:       v.string(),
    SYVSCHD_CRSE_NUMB:       v.string(),
    SYVSCHD_SEQ_NUMB:        v.string(),
    SYVSCHD_CRSE_LONG_TITLE: v.string(),
    SYVSCHD_SCHD_CODE:       v.string(),
    SYVSCHD_INSM_CODE:       v.string(),
    SYVSCHD_PTRM_START_DATE: v.string(),
    SYVSCHD_PTRM_END_DATE:   v.string(),
    CREDITS_HRS:             v.string(),
    INSTRUCTORS:             v.array(v.object({ LAST_NAME: v.nullish(v.string()), FIRST_NAME: v.nullish(v.string()), EMAIL: v.nullish(v.string()) })),
    MEETINGS:                v.array(v.object({ DAYS: v.string(), BUILDING: v.string(), ROOM: v.string(), BUILDING_DESC: v.string(), TIME: v.string(), START_DATE: v.string(), END_DATE: v.string() })),
    CROSS_LISTED:            v.array(v.object({ SYVSCHD_CRN: v.optional(v.string()), CRN: v.optional(v.string()) }))
  })
})

/** "10:10am - 12:00pm" as minutes after midnight, or none for "Hours Arranged" */
export const parseTime = (time: string): [number, number] | undefined => {
  const [, h1, m1, p1, h2, m2, p2] = time.match(/^(\d{1,2}):(\d\d)([ap])m - (\d{1,2}):(\d\d)([ap])m$/) ?? []
  if (!h1)
    return undefined
  const minutes = (h: string, m: string, p: string) => ((+h % 12) + (p === "p" ? 12 : 0)) * 60 + +m
  return [minutes(h1, m1, p1), minutes(h2, m2, p2)]
}

/** "8/31/2026" as a Durham day */
const dayOf = (us: string) => {
  const [m, d, y] = us.split("/")
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
}

/** What a check found wrong, each issue where it was */
const describe = (issues: readonly v.BaseIssue<unknown>[]) =>
  issues.map(issue => `${v.getDotPath(issue) ?? ""}: ${issue.message}`).join("; ")

export class MalformedRow extends Error {
  constructor(index: number, crn: unknown, issues: string) {
    super(`Row ${index}${typeof crn === "string" ? ` (CRN ${crn})` : ""} isn't a section as this import reads one: ${issues}`)
  }
}

/** How a meeting's building code and description are placed: a gazetteer name, nowhere, or a throw (placeOfCode) */
export type Placer = (code: string, description: string) => string | undefined

/** Rows as sections, placed, the first numbered `first`; a row of a shape not known fails the import rather than vanishing */
export const fromDhub = (rows: readonly unknown[], place: Placer, first = 0): Section[] =>
  rows.map((row, i) => {
    const parsed = v.safeParse(Row, row)
    if (!parsed.success)
      throw new MalformedRow(first + i, (row as { COURSE_DATA?: { SYVSCHD_CRN?: unknown } })?.COURSE_DATA?.SYVSCHD_CRN, describe(parsed.issues))
    const c = parsed.output.COURSE_DATA
    const section: Section = {
      crn:         c.SYVSCHD_CRN,
      subject:     c.SYVSCHD_SUBJ_CODE,
      number:      c.SYVSCHD_CRSE_NUMB,
      section:     c.SYVSCHD_SEQ_NUMB,
      title:       c.SYVSCHD_CRSE_LONG_TITLE.trim(),
      kind:        c.SYVSCHD_SCHD_CODE,
      mode:        c.SYVSCHD_INSM_CODE,
      credits:     c.CREDITS_HRS,
      from:        c.SYVSCHD_PTRM_START_DATE,
      to:          c.SYVSCHD_PTRM_END_DATE,
      instructors: c.INSTRUCTORS.flatMap(({ FIRST_NAME, LAST_NAME, EMAIL }) => {
        const name = [FIRST_NAME, LAST_NAME].filter(Boolean).join(" ").trim()
        return name ? [{ name, ...EMAIL?.trim() ? { mail: hide(EMAIL.trim().toLowerCase()) } : {} }] : []
      }),
      meetings:    c.MEETINGS.map(m => {
        const time = parseTime(m.TIME)
        const placed = place(m.BUILDING, m.BUILDING_DESC)
        return {
          days:  time ? m.DAYS : "",
          start: time?.[0] ?? 0,
          end:   time?.[1] ?? 0,
          from:  dayOf(m.START_DATE),
          to:    dayOf(m.END_DATE),
          ...placed ? { place: placed } : {},
          where: [m.BUILDING_DESC || m.BUILDING, m.ROOM].filter(Boolean).join(" ")
        }
      }),
      crossListed: c.CROSS_LISTED.flatMap(x => x.SYVSCHD_CRN ?? x.CRN ?? [])
    }
    const checked = v.safeParse(SectionSchema, section)
    if (!checked.success)
      throw new MalformedRow(first + i, c.SYVSCHD_CRN, describe(checked.issues))
    return section
  })

/** A page of a term as read: its rows, the API's total, and when the API answered, by its clock where it says */
export type PageRead = { rows: readonly unknown[], total: number, fetched: number }

/**
 * A term from its pages: every row read, the count reconciled with the API's total, each CRN once, and stamped with
 * when the registrar answered for its oldest page, which is what freshness means
 */
export const importTerm = async (code: string, pages: AsyncIterable<PageRead> | Iterable<PageRead>, place: Placer) => {
  const sections: Section[] = []
  let fetched = Infinity
  let total: number | undefined
  for await (const page of pages) {
    sections.push(...fromDhub(page.rows, place, sections.length))
    fetched = Math.min(fetched, page.fetched)
    total ??= page.total
    if (page.total !== total)
      throw new Error(`${code}: the API's total changed from ${total} to ${page.total} between pages; fetch the term again`)
  }
  if (total === undefined || sections.length !== total)
    throw new Error(`${code}: read ${sections.length} sections but the API says ${total}`)
  const crns = new Set<string>()
  for (const { crn } of sections)
    if (crns.size === crns.add(crn).size)
      throw new Error(`${code}: CRN ${crn} appears twice`)
  return { code, name: termName(code), fetched, sections }
}

/** A page read, its time the API's own clock where it gives one, else when it was read */
export const pageRead = (page: Page, read: number): PageRead =>
  ({ rows: page.data, total: page["total-count"], fetched: page.timestamp ? Date.parse(page.timestamp) : read })
