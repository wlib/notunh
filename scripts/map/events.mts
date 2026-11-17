// Fetches UNH's public event calendars into src/map/events.json, one request each, as the inputs are made nightly
// (scripts/data.mts): Presence (Wildcat Link) whole, as it answers the past month and what's upcoming; 25Live
// Publisher a week at a time, as it answers at most 200 entries; Wildcat Link's clubs, whose weekly meetings are told
// on the class days of the academic calendar the courses step read; Athletics' ICS whole; sport clubs' events from
// DSE Rec, the same weeks in one page, from the JSON its own pages ask for, without our User-Agent; and Campus Rec's
// programs, found by classification, each program's page then its sessions or its offerings in each of its
// semesters. Only events are asked of DSE, never its rosters or members. The series only UNH's pages tell, kept by
// hand (src/social/curated.mts), join them over the same weeks. Each is read into the one event shape
// (src/social/sources.mts), placed on the gazetteer by name (src/social/aliases.mts), and events already over are
// left out. If any calendar fails, the step fails and the last night's file stays (scripts/data.mts); a build without
// one gets an empty list (scripts/inputs.mts)

import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { fileURLToPath } from "node:url"
import { getJson } from "../../src/shared/json.mts"
import type { Event, EventsData } from "../../src/social/event.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { ATHLETICS, EVENTS, PRESENCE, PRESENCE_CLUBS, REC_INDEX, WEEKS, classificationUrl, classificationsOf, dserecUrl, from25Live, fromAthletics, fromDserec, fromPresence, fromPresenceClubs, fromRecInstances, fromRecOfferings, instancesUrl, live25Url, merged, offeringsUrl, programOf, programUrl, programsOf } from "../../src/social/sources.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { Curated, fromCurated } from "../../src/social/curated.mts"
import curated from "../../src/social/curated.json" with { type: "json" }
import { addDays, localDay } from "../../src/shared/time.mts"
import { COURSES, CoursesIndex } from "../../src/courses/course.mts"
import { classDays } from "../../src/courses/calendar.mts"
import { STAGED, exists, writeInput } from "../files.mts"

/** Who's asking, as the Worker says it too (worker/collect.mts) */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

/** A 25Live week's URL, from a Durham day */
const weekUrl = (day: string) =>
  live25Url(day, 7)

const now = Date.now()
const today = localDay(now)
const gazetteer = v.parse(Gazetteer, JSON.parse(await readFile(fileURLToPath(new URL("../../src/map/gazetteer.json", import.meta.url)), "utf8")))
const match = placeMatcher(gazetteer.places.map(place => place.name))

const init = { headers: HEADERS, signal: AbortSignal.timeout(30_000) }
const [presence, organizations, athletics, clubs, ...weeks] = await Promise.all([
  getJson(PRESENCE, init),
  getJson(PRESENCE_CLUBS, init),
  fetch(ATHLETICS, init).then(response => response.ok ? response.text() : Promise.reject(new Error(`${response.status} from ${ATHLETICS}`))),
  getJson(dserecUrl(today, addDays(today, 7 * WEEKS - 1)), { signal: AbortSignal.timeout(30_000) }),
  ...Array.from({ length: WEEKS }, (_, i) => getJson(weekUrl(addDays(today, 7 * i)), init))
])

const text = (url: string) =>
  fetch(url, init).then(response => response.ok ? response.text() : Promise.reject(new Error(`${response.status} from ${url}`)))

// Campus Rec's programs, each classification's listed, then each program's page, then its sessions on its calendar or
// its offerings in each semester the page names, one at a time, as Fusion's a small site
const listed = new Set<string>()
for (const classification of classificationsOf(await text(REC_INDEX)))
  for (const id of programsOf(await text(classificationUrl(classification))))
    listed.add(id)
if (!listed.size)
  throw new Error("Campus Rec's index lists no programs")
const programs: Event[][] = []
for (const id of listed) {
  const program = { id, ...programOf(await text(programUrl(id))) }
  if (program.byCalendar)
    programs.push(fromRecInstances(await text(instancesUrl(id)), program, match))
  else
    for (const semester of program.semesters)
      programs.push(fromRecOfferings(await text(offeringsUrl(id, semester.id)), program, semester.name, match))
}

// Clubs meet on class days, as the academic calendar the courses step read tonight (scripts/data.mts) says, else
// the one installed; with neither, no club's meetings are told
const calendarIn = async (file: URL) =>
  await exists(file) ? v.parse(CoursesIndex, JSON.parse(await readFile(file, "utf8"))).calendar : undefined
const calendar = await calendarIn(new URL(COURSES, STAGED)) ?? await calendarIn(new URL(`../../${COURSES}`, import.meta.url))
const meetings = fromPresenceClubs(organizations, calendar ? classDays(calendar, today, 7 * WEEKS) : [], match)

const series = fromCurated(v.parse(Curated, curated), today, 7 * WEEKS, match)
const events = merged([
  fromPresence(presence, match),
  meetings,
  fromAthletics(athletics, match),
  fromDserec(clubs, match),
  ...weeks.map(week => from25Live(week, match)),
  ...programs,
  series
], now)
await writeInput(EVENTS, JSON.stringify({ fetched: now, events } satisfies EventsData) + "\n")
console.log(`${events.length} events, ${events.filter(event => event.place).length} placed`)
