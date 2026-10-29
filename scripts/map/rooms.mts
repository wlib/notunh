// Fetches the rooms to book and the coming week's bookings into src/map/rooms.json, as the inputs are made nightly
// (scripts/data.mts), so a room's page opens with what was booked as of the night before, offline too, until the
// Worker's word comes (worker/rooms.mts): 25Live's spaces, then each day of them, one request a day; and Campus Rec's
// facilities from its schedule page, then each one's week, one request each (src/courses/rec.mts), which is all the
// map ever knows of those. Spaces are placed on the gazetteer by name (src/social/aliases.mts). The file is public,
// so no title is kept, as for anyone unverified (src/courses/bookings.mts). If either fails, the step fails and the
// last night's file stays (scripts/data.mts); a build without one has no rooms to book (scripts/inputs.mts)

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { getJson } from "../../src/shared/json.mts"
import { type Booking, type RoomsData, ROOMS, SPACES, bookingsFrom, reservationsUrl, shownTo, spacesFrom, weekFrom } from "../../src/courses/bookings.mts"
import { SCHEDULE, facilitiesFrom, recBookingsFrom, scheduleUrl } from "../../src/courses/rec.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { addDays, dayStart, localDay } from "../../src/shared/time.mts"
import { writeInput } from "../files.mts"

/** Who's asking, as the Worker says it too (worker/collect.mts) */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

const init = () =>
  ({ headers: HEADERS, signal: AbortSignal.timeout(60_000) })

const gazetteer = v.parse(Gazetteer, JSON.parse(await readFile(fileURLToPath(new URL("../../src/map/gazetteer.json", import.meta.url)), "utf8")))
const match = placeMatcher(gazetteer.places.map(place => place.name))

const now = Date.now()
const week = weekFrom(localDay(now))
const [first, last] = [week[0], week.at(-1)!]
const spaces = spacesFrom(await getJson(SPACES, init()), match)
const facilities = facilitiesFrom(await fetch(SCHEDULE, init()).then(response => response.ok ? response.text() : Promise.reject(new Error(`${response.status} from ${SCHEDULE}`))), match)

// One facility at a time, as Fusion's a small site, and one day of 25Live at a time, as it takes seconds over each
const rec: Booking[] = []
for (const { id } of facilities)
  rec.push(...recBookingsFrom(await getJson(scheduleUrl(id, first, last), init()), id, first, last))
const days: RoomsData["days"] = []
for (const day of week) {
  const touches = ({ start, end }: Booking) => start < dayStart(addDays(day, 1)) && end > dayStart(day)
  days.push({ day, fetched: Date.now(), bookings: shownTo([...bookingsFrom(await getJson(reservationsUrl(day, spaces.map(space => space.id)), init())), ...rec.filter(touches)], false) })
}

await writeInput(ROOMS, JSON.stringify({ fetched: now, spaces: [...spaces, ...facilities], days } satisfies RoomsData) + "\n")
console.log(`${spaces.length} rooms, ${spaces.filter(space => space.isStudy).length} study rooms, ${facilities.length} Campus Rec facilities, ${days.reduce((sum, { bookings }) => sum + bookings.length, 0)} bookings over ${days.length} days`)
