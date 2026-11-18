// Final exams: when each section's is and in which rooms, from the registrar's Final Exam Schedule, a spreadsheet
// published about mid-semester for each term and linked from its examinations page (scripts/map/finals.mts reads it
// nightly). The sheet is a row per CRN and room: a common exam has a row for each of its rooms, and never says which
// student sits in which, so its rooms are "one of"; a few sections sit their final in parts, on two days, so a CRN has
// a sitting for each time its rows name. Rooms are the registrar's building codes, placed as a meeting's are
// (buildings.mts) and written as the term's own meetings write that building, so a final's room is the room's page.
// The sheet names no one. Still, finals are told only to a device whose person holds a verified UNH address: they're
// stored by the Worker, never in a file anyone can fetch, and answered per term to such a device (worker/finals.mts).
// Anyone else is told only the term's finals window, from the academic calendar. Pure

import * as v from "valibot"
import { type UnknownBuilding, placeOfCode } from "./buildings.mts"
import { type CourseEvent, type Section, type Term, Minute, clock, codeOf, courseOf, sectionUrl } from "./course.mts"
import type { Entry } from "../shared/ics.mts"
import { on, spanOn } from "../shared/recur.mts"
import { SITE } from "../shared/site.mts"
import { plainDay } from "../shared/temporal.mts"
import { type Day, Day as DaySchema, addDays } from "../shared/time.mts"

/** The registrar's page linking each term's schedule, once it's published, and "Final Exam Schedule - TBA" till then */
export const EXAMINATIONS = "https://www.unh.edu/registrar/registration-resources/examinations"

/** A room a final is in: a gazetteer name where the map knows the building, and the room as the registrar's meetings write it */
export const Room = v.object({ place: v.optional(v.string()), where: v.string() })
export type Room = v.InferOutput<typeof Room>

/** A final, or one part of one sat at another time */
export const Final = v.object({
  day:   DaySchema,
  start: Minute,
  end:   Minute,
  /** Every room it's in, as the sheet lists them; more than one is a common exam, sat in one of them */
  rooms: v.array(Room)
})
export type Final = v.InferOutput<typeof Final>

const Crn = v.pipe(v.string(), v.regex(/^\d{5}$/))

/** A term's finals, by CRN, from the sheet linked when it was read */
export const TermFinals = v.object({
  name:    v.string(),
  /** The sheet's link on the examinations page */
  source:  v.string(),
  fetched: v.number(),
  finals:  v.record(Crn, v.array(Final))
})
export type TermFinals = v.InferOutput<typeof TermFinals>

/** What the finals are stored under in the Worker, beside the models (worker/models.mts) */
export const FINALS = "finals"

/** What the Worker stores whole, as of the day it was read, each term's finals by its code */
export const Finals = v.object({
  version: v.literal(1),
  through: DaySchema,
  terms:   v.record(v.string(), TermFinals)
})
export type Finals = v.InferOutput<typeof Finals>

/** What a verified device is told of a term (GET /api/finals/:term) */
export const Told = v.object({ code: v.string(), fetched: v.number(), finals: v.record(Crn, v.array(Final)) })
export type Told = v.InferOutput<typeof Told>

//#region The examinations page

const decoded = (html: string) =>
  html.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", nbsp: " " })[name]!)

/**
 * Each term's Final Exam Schedule link on the examinations page, by the term's name as its heading says it ("Fall
 * 2026"). A term whose schedule is "TBA" has no link and isn't listed
 */
export const scheduleLinks = (html: string) =>
  [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>([\s\S]*?)(?=<h[23][\s>]|$)/g)].flatMap(([, heading, body]) => {
    const name = decoded(heading).replace(/\s+/g, " ").trim()
    const link = [...body.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .find(([, , text]) => /^final exam schedule$/i.test(decoded(text.replace(/<[^>]*>/g, "")).trim()))
    return /^(Fall|Spring|Summer|J-?Term) \d{4}$/i.test(name) && link ? [{ name, url: decoded(link[1]) }] : []
  })

/** A SharePoint share link as its file, rather than the page that views it */
export const downloadUrl = (link: string) => {
  const url = new URL(link)
  url.searchParams.set("download", "1")
  return url.href
}

//#endregion

//#region The sheet

/** A cell as the sheet holds it: text, a number, or nothing */
export type Cell = string | number | undefined

/** Where each column the import reads is, by its header's words */
const HEADERS = {
  crn:   /^crn$/i,
  day:   /date/i,
  times: /time/i,
  code:  /^(bldg|building)/i,
  room:  /^room/i
}

export class MalformedSheet extends Error {}

/** Sittings in order: by day, then start */
export const bySitting = (a: Final, b: Final) =>
  a.day.localeCompare(b.day) || a.start - b.start

/** "8:00am-10:00am", or with spaces, or a bare hour, as minutes after midnight */
export const timesOf = (text: string): [number, number] | undefined => {
  const [, h1, m1 = "00", p1, h2, m2 = "00", p2] = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d\d))?\s*([ap])\.?m?\.?\s*[-–]\s*(\d{1,2})(?::(\d\d))?\s*([ap])\.?m?\.?$/) ?? []
  if (!h1)
    return undefined
  const minutes = (h: string, m: string, p: string) => (+h % 12 + (p === "p" ? 12 : 0)) * 60 + +m
  const span: [number, number] = [minutes(h1, m1, p1), minutes(h2, m2, p2)]
  return span[0] < span[1] && span[1] < 1440 ? span : undefined
}

/** An Excel date serial, days since 1899-12-30, or the registrar's "12/15/2026", as a Durham day */
export const dayOf = (cell: Cell): Day | undefined => {
  if (typeof cell === "number" && Number.isInteger(cell) && cell > 40_000 && cell < 80_000)
    return addDays("1899-12-30", cell)
  const [, m, d, y] = String(cell ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) ?? []
  return y ? `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : undefined
}

/** How a building code and room become a final's room: placed, and written as the term's meetings write them */
export type Placer = (code: string, room: string) => Room

/** What the sheet's codes for nowhere say, as a room */
const NOWHERE: Record<string, string> = { ONLINE: "Online", OFFCMP: "Off campus", TBA: "TBA", ABROAD: "Abroad" }

/**
 * The placer for a term: a code placed as a meeting's is, given the gazetteer's names, and written as the term's own
 * meetings write the building there ("Kingsbury N343", "Paul College Business&Econ 165"), so the room is the one its
 * classes are in; a building none of them meet in is written by its name on the map, else its code. A code the table
 * can't place goes to `unknown`, and its room is written with the code and placed nowhere
 */
export const placerFor = (names: ReadonlySet<string>, sections: readonly Pick<Section, "meetings">[], unknown?: (error: UnknownBuilding) => void): Placer => {
  const place = placeOfCode(names, unknown)
  const written = new Map<string, Map<string, number>>()
  for (const { meetings } of sections)
    for (const { place, where } of meetings) {
      const building = where.split(" ").slice(0, -1).join(" ")
      if (place && building) {
        const counts = written.get(place) ?? written.set(place, new Map()).get(place)!
        counts.set(building, (counts.get(building) ?? 0) + 1)
      }
    }
  const usual = (place: string) =>
    [...written.get(place) ?? []].sort((a, b) => b[1] - a[1])[0]?.[0]
  return (code, room) => {
    const placed = place(code, code)
    if (!placed && Object.hasOwn(NOWHERE, code))
      return { where: NOWHERE[code] }
    const building = placed ? usual(placed) ?? placed : code
    return { ...placed && { place: placed }, where: [building, room].filter(Boolean).join(" ") }
  }
}

/**
 * The sheet's rows as finals by CRN, each CRN's sittings soonest first, and how many rows were read: the first row
 * whose cells name the columns is the header, and each row after it with a CRN is a room of that CRN's final at its
 * time. Fails loud, naming the row, where one can't be read, so a changed sheet can't ship half read
 */
export const fromSheet = (rows: readonly (readonly Cell[])[], place: Placer) => {
  const header = rows.findIndex(row => row.some(cell => HEADERS.crn.test(String(cell ?? "").trim())))
  if (header < 0)
    throw new MalformedSheet("No row of the sheet names a CRN column")
  const column = Object.fromEntries(Object.entries(HEADERS).map(([key, pattern]) => {
    const i = rows[header].findIndex(cell => pattern.test(String(cell ?? "").trim()))
    if (i < 0)
      throw new MalformedSheet(`The sheet has no column for ${key}`)
    return [key, i]
  })) as Record<keyof typeof HEADERS, number>
  const finals: Record<string, Final[]> = {}
  let read = 0
  for (const [i, row] of rows.entries()) {
    const text = (key: keyof typeof HEADERS) => String(row[column[key]] ?? "").trim()
    if (i <= header || !text("crn"))
      continue
    read++
    const crn = text("crn").padStart(5, "0")
    const day = dayOf(row[column.day])
    const times = timesOf(text("times"))
    if (!/^\d{5}$/.test(crn) || !day || !times || !text("code"))
      throw new MalformedSheet(`Row ${i + 1} (CRN ${crn}) isn't a final as this import reads one: ${JSON.stringify(row)}`)
    const room = place(text("code").toUpperCase(), text("room"))
    const sittings = finals[crn] ??= []
    const known = sittings.find(final => final.day === day && final.start === times[0] && final.end === times[1])
    if (!known)
      sittings.push({ day, start: times[0], end: times[1], rooms: [room] })
    else if (!known.rooms.some(({ where }) => where === room.where))
      known.rooms.push(room)
  }
  for (const sittings of Object.values(finals))
    sittings.sort(bySitting)
  return { finals, rows: read }
}

/**
 * What's stored after a night's reading: the terms read, and the terms stored before that weren't read, while their
 * finals aren't a week over, so a page that drops a link a while doesn't take a term's finals with it
 */
export const merged = (before: Finals | undefined, read: Record<string, TermFinals>, today: Day): Finals => {
  const kept = Object.entries(before?.terms ?? {}).filter(([code, term]) =>
    !Object.hasOwn(read, code) && Object.values(term.finals).flat().some(({ day }) => addDays(day, 7) >= today))
  return { version: 1, through: today, terms: { ...Object.fromEntries(kept), ...read } }
}

//#endregion

//#region Read

/** A section's final, each sitting: its own, else that of a section it's cross-listed with, which meets with it */
export const finalsOf = (finals: Readonly<Record<string, readonly Final[]>> | undefined, section: Pick<Section, "crn" | "crossListed">): readonly Final[] =>
  finals?.[section.crn] ?? section.crossListed.map(crn => finals?.[crn]).find(Boolean) ?? []

/** A final's rooms in words, "Kingsbury N343", or a common exam's, "SLS 145, Murkland 115" */
export const roomsOf = (final: Pick<Final, "rooms">) =>
  final.rooms.map(({ where }) => where).join(", ")

/** The one place a final is, where it's in rooms of one building, which Directions and the map's focus need */
export const placeOfFinal = (final: Pick<Final, "rooms">) => {
  const places = new Set(final.rooms.map(({ place }) => place))
  return places.size === 1 ? [...places][0] : undefined
}

/** A final as the event it is, on its day, at its one place where it has one: what Directions, a row and the week read */
export const eventOfFinal = (term: Pick<Term, "code">, section: Section, final: Final): CourseEvent => ({
  id:     `course:${term.code}:${section.crn}:${final.day}:final${clock(final.start).replace(":", "")}`,
  title:  `${courseOf(section)} · Final`,
  ...spanOn({ start: clock(final.start), end: clock(final.end) }, plainDay(final.day)),
  place:  placeOfFinal(final),
  where:  roomsOf(final),
  source: "course",
  url:    sectionUrl(term.code, section.crn),
  term:   term.code,
  crn:    section.crn,
  key:    "final"
})

/** The sittings of some sections' finals that overlap a sitting of another's, which the registrar calls a conflict */
export const conflicting = <T extends { crn: string, final: Final },>(sittings: readonly T[]) =>
  new Set(sittings.filter(one => sittings.some(other => other.crn !== one.crn && one.final.day === other.final.day && one.final.start < other.final.end && other.final.start < one.final.end)))

/**
 * A sitting of a final as a calendar entry, named for good by its section and which sitting it is, so a revised sheet
 * moves it in place
 */
export const entryOfFinal = (term: Pick<Term, "code">, section: Section, final: Final, sitting = 0): Entry => ({
  uid:         `course-${term.code}-${section.crn}-final${sitting ? `-${sitting + 1}` : ""}@notunh.app`,
  title:       `${courseOf(section)} Final`,
  description: `${codeOf(section)} ${section.title}${final.rooms.length > 1 ? " · a common final, in one of its rooms" : ""}`,
  where:       final.rooms.map(({ where }) => where).join(" or "),
  url:         `${SITE}${sectionUrl(term.code, section.crn)}`,
  session:     { rule: on(final.day), start: clock(final.start), end: clock(final.end) }
})

//#endregion
