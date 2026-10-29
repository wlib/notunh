// Fetches UNH's public event calendars into src/map/events.json, one request each, as the inputs are made nightly
// (scripts/data.mts): Presence (Wildcat Link) whole, as it answers the past month and what's upcoming; 25Live
// Publisher a week at a time, as it answers at most 200 entries; Athletics' ICS whole; and sport clubs' events from
// DSE Rec, the same weeks in one page, from the JSON its own pages ask for, without our User-Agent; and Campus Rec's
// programs, each program's page then its offerings in each of its semesters. Only events are asked of DSE, never its
// rosters or members. Each is read into the one event shape (src/social/sources.mts), placed
// on the gazetteer by name (src/social/aliases.mts), and events already over are left out. If any calendar fails, the
// step fails and the last night's file stays (scripts/data.mts); a build without one gets an empty list
// (scripts/inputs.mts)

import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { fileURLToPath } from "node:url"
import { getJson } from "../../src/shared/json.mts"
import type { Event, EventsData } from "../../src/social/event.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { ATHLETICS, EVENTS, PRESENCE, REC_PROGRAMS, dserecUrl, from25Live, fromAthletics, fromDserec, fromPresence, fromRecOfferings, live25Url, merged, offeringsUrl, programOf, programUrl } from "../../src/social/sources.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { addDays, localDay } from "../../src/shared/time.mts"
import { writeInput } from "../files.mts"

/** Who's asking, as the Worker says it too (worker/collect.mts) */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

/** Weeks of 25Live and DSE Rec fetched, from this one */
const WEEKS = 3

/** A 25Live week's URL, from a Durham day */
const weekUrl = (day: string) =>
  live25Url(day, 7)

const now = Date.now()
const today = localDay(now)
const gazetteer = v.parse(Gazetteer, JSON.parse(await readFile(fileURLToPath(new URL("../../src/map/gazetteer.json", import.meta.url)), "utf8")))
const match = placeMatcher(gazetteer.places.map(place => place.name))

const init = { headers: HEADERS, signal: AbortSignal.timeout(30_000) }
const [presence, athletics, clubs, ...weeks] = await Promise.all([
  getJson(PRESENCE, init),
  fetch(ATHLETICS, init).then(response => response.ok ? response.text() : Promise.reject(new Error(`${response.status} from ${ATHLETICS}`))),
  getJson(dserecUrl(today, addDays(today, 7 * WEEKS - 1)), { signal: AbortSignal.timeout(30_000) }),
  ...Array.from({ length: WEEKS }, (_, i) => getJson(weekUrl(addDays(today, 7 * i)), init))
])

const text = (url: string) =>
  fetch(url, init).then(response => response.ok ? response.text() : Promise.reject(new Error(`${response.status} from ${url}`)))

// Each program's page, then its offerings in each semester the page names, one at a time, as Fusion's a small site
const programs: Event[][] = []
for (const id of REC_PROGRAMS) {
  const program = { id, ...programOf(await text(programUrl(id))) }
  for (const semester of program.semesters)
    programs.push(fromRecOfferings(await text(offeringsUrl(id, semester.id)), program, semester.name, match))
}

const events = merged([fromPresence(presence, match), fromAthletics(athletics, match), fromDserec(clubs, match), ...weeks.map(week => from25Live(week, match)), ...programs], now)
await writeInput(EVENTS, JSON.stringify({ fetched: now, events } satisfies EventsData) + "\n")
console.log(`${events.length} events, ${events.filter(event => event.place).length} placed`)
