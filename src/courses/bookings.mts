// The rooms anyone can book and what's booked in them, from 25Live, which UNH books nearly every space through: the
// spaces placed on the map, and a day's reservations, read into one shape, a Booking. Pure, so the build
// (scripts/map/rooms.mts) and the Worker (worker/rooms.mts) read 25Live with it, and the map merges what each says.
// Campus Rec's courts, studios and fields are spaces of the same shapes (rec.mts), known from the build alone.
//
// What's never read: who booked (25Live's last_mod_user is a NetID), and the event's own record (event.json names
// its requester). Classes are booked "(Private)", and are left out, as the registrar's sections say them better
// (rooms.mts). Any title may name a person ("Ava and Flossie study anatomy"), so titles are said only to a device
// with a verified UNH address, which the Worker decides per request (shownTo); anyone else is told what kind of
// booking it is and the organization's name. An organization that's students as themselves is never kept, as it's
// no one's to know. The build's snapshot, which anyone can fetch, has no titles

import * as v from "valibot"
import { usable } from "../shared/json.mts"
import { Day, addDays, dayStart, localDay } from "../shared/time.mts"
import type { Matcher } from "../social/sources.mts"

/** Where the build keeps the spaces and the coming week's bookings, as scripts/map/rooms.mts writes them */
export const ROOMS = "src/map/rooms.json"

/** Where a room is booked: its page in UNH's 25Live Pro, which signing in with a NetID comes back to */
export const reserveUrl = (space: Pick<Space, "id">) =>
  `https://25live.collegenet.com/pro/unh#!/home/location/${space.id}/details`

const DATA = "https://25live.collegenet.com/25live/data/unh/run"

/** Every space 25Live lists, in one page */
export const SPACES = `${DATA}/spaces.json?page_size=5000`

/** A day's reservations, of some spaces or every one; 25Live's dates are YYYYMMDD */
export const reservationsUrl = (day: Day, spaces?: readonly string[]) =>
  `${DATA}/rm_reservations.json?${spaces ? `space_id=${spaces.join("+")}&` : ""}start_dt=${day.replaceAll("-", "")}&end_dt=${day.replaceAll("-", "")}`

//#region Shapes

/**
 * A space on the map: its id where it's booked, 25Live's ("532") or Campus Rec's (rec.mts), its building as the
 * gazetteer names it, its room as it's said ("121", "221A" for 25Live's "221_A"; none for a field that's a place of
 * its own), what it's called where that's said ("Collaboration Space", "Strafford Room"), how many it holds where
 * that's known, whether it's a study room, and the space it's within, as a court is in its gym, which booked books
 * it too. Its page is at `where`, the building and room
 */
export const Space = v.object({
  id:       v.string(),
  source:   v.picklist(["25live", "rec"]),
  where:    v.string(),
  place:    v.string(),
  room:     v.string(),
  name:     v.optional(v.string()),
  capacity: v.optional(v.number()),
  isStudy:  v.boolean(),
  within:   v.optional(v.string())
})
export type Space = v.InferOutput<typeof Space>

/** A reservation of a space, in epoch ms, of a kind ("Meeting", a study group's), with its title and organization unless they're kept back */
export const Booking = v.object({
  space: v.string(),
  start: v.number(),
  end:   v.number(),
  type:  v.string(),
  title: v.optional(v.string()),
  org:   v.optional(v.string())
})
export type Booking = v.InferOutput<typeof Booking>

/** What was said to be booked on a day, and when it was said */
export const Booked = v.object({
  day:      Day,
  fetched:  v.number(),
  bookings: usable(Booking)
})
export type Booked = v.InferOutput<typeof Booked>

/** The build's rooms.json: the spaces, 25Live's and Campus Rec's, and the coming week's bookings of them all, a day each */
export const RoomsData = v.object({
  fetched: v.number(),
  spaces:  usable(Space),
  days:    v.array(Booked)
})
export type RoomsData = v.InferOutput<typeof RoomsData>

export const NO_ROOMS: RoomsData = { fetched: 0, spaces: [], days: [] }

//#endregion

//#region 25Live

const UpstreamSpace = v.object({
  space_id:      v.number(),
  space_name:    v.string(),
  formal_name:   v.string(),
  building_name: v.string(),
  max_capacity:  v.optional(v.union([v.number(), v.string()]))
})

/** 25Live's answers hold a list, one item bare, or nothing at all, as its XML is turned into JSON */
const listed = (value: unknown) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

/** Spaces that aren't rooms to meet in: tables, offices, lounges counted as one, food courts, and the like */
const NOT_ROOMS = /\b(info\b|misc|lactation|office|food court|lobby|deck|prayer|green room|kitchen|calendar only)/i

/** Buildings 25Live lists off the Durham campus, or nowhere */
const ELSEWHERE = /^(UNHM|UNH School of Law|Online|Outdoor Spaces|$)/

/** What a space is called, from its formal name after its room: "Dimond Library 121 Collaboration Space" */
const nameOf = (formal: string, room: string) => {
  const at = formal.indexOf(` ${room} `)
  return (at < 0 ? "" : formal.slice(at + room.length + 2)).replace(/\([A-Z]+\)\s*$/, "").replace(/\s+/g, " ").trim() || undefined
}

/** A room's number as it's said: a one-character part after an underscore joined, "221_A" as "221A", else set apart, "A154 Pool" */
const roomSaid = (room: string) =>
  room.replace(/_(\w)(?!\w)/g, "$1").replaceAll("_", " ")

/** The spaces of 25Live's list that are rooms on the Durham campus the gazetteer places. A capacity of one is 25Live's for none given */
export const spacesFrom = (json: unknown, match: Matcher): Space[] =>
  v.parse(usable(UpstreamSpace), listed(Object(Object(json).spaces).space)).flatMap(space => {
    const room = space.space_name.trim().split(/\s+/).slice(1).join(" ")
    const place = match(space.building_name) ?? match(space.formal_name)
    if (!room || !place || ELSEWHERE.test(space.building_name.trim()) || NOT_ROOMS.test(space.formal_name))
      return []
    const capacity = Number(space.max_capacity)
    const name = nameOf(space.formal_name, room)
    return [{
      id:      String(space.space_id),
      source:  "25live",
      where:   `${place} ${roomSaid(room)}`,
      place,
      room:    roomSaid(room),
      ...name && { name },
      ...capacity > 1 && { capacity },
      isStudy: /collaboration|study/i.test(space.formal_name)
    }]
  })

/** 25Live's times, local with their offset, "2026-10-28T09:40:00-04:00"; one without would be read in the runtime's zone */
const Stamp = v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?([+-]\d\d:\d\d|Z)$/))

const Reservation = v.object({
  reservation_start_dt: Stamp,
  reservation_end_dt:   Stamp,
  reservation_state:    v.optional(v.number()),
  spaces:               v.object({ space_id: v.number() }),
  event:                v.object({
    event_name:        v.string(),
    event_type_name:   v.optional(v.string()),
    organization_name: v.optional(v.string())
  })
})

/** 25Live's state for a reservation cancelled */
const CANCELLED = 99

/**
 * A day's bookings from 25Live's reservations, but classes, "(Private)", and those cancelled, with every title, which
 * shownTo keeps back, and their organizations, but students as themselves
 */
export const bookingsFrom = (json: unknown): Booking[] =>
  v.parse(usable(Reservation), listed(Object(Object(json).space_reservations).space_reservation)).flatMap(({ reservation_start_dt, reservation_end_dt, reservation_state, spaces, event }) => {
    const [start, end] = [Date.parse(reservation_start_dt), Date.parse(reservation_end_dt)]
    if (event.event_name === "(Private)" || reservation_state === CANCELLED || !(start < end))
      return []
    const title = event.event_name.trim()
    const org = event.organization_name?.trim().replace(/^\(Private\)$/, "")
    return [{ space: String(spaces.space_id), start, end, type: event.event_type_name?.trim() ?? "", ...title && { title }, ...org && !isPersonal({ org }) && { org } }]
  })

//#endregion

//#region Who's told what

export const STUDY_GROUP = "Student Collaboration / Study Group"

/** Whether a booking's organization is students as themselves ("Durham - Student", "Law-Student") or none, so its name may be a person's */
export const isPersonal = (booking: Pick<Booking, "org">) =>
  /^$|student$/i.test(booking.org ?? "")

/** Bookings as said to someone: whole to a device with a verified UNH address, else without titles */
export const shownTo = (bookings: readonly Booking[], isVerified: boolean): Booking[] =>
  isVerified ? [...bookings] : bookings.map(({ title, ...booking }) => booking)

/** What kind of booking it is, a study group's in a word, or nothing for a kind unsaid */
export const kindOf = (booking: Pick<Booking, "type">) =>
  booking.type === STUDY_GROUP ? "Study group" : booking.type || undefined

//#endregion

//#region What's known

/** What's known of a day: its bookings, each space's as of the latest answer that covered it, fetched as `fetched` says */
export type Known = { bookings: Booking[], fetched: Record<string, number> }

export const UNKNOWN: Known = { bookings: [], fetched: {} }

/** When what's known of a space on a day was fetched, or 0 for never */
export const fetchedOf = (known: Known, space: string) =>
  known.fetched[space] ?? 0

/**
 * What's known of a day once an answer comes covering some spaces, every one it could have said a booking of: each
 * space as whichever answer is newer says, so a day's answer cached longer never undoes a room's asked since, nor
 * 25Live's Campus Rec's, and answers in any order end the same
 */
export const learned = (known: Known, answer: Booked, covers: readonly string[]): Known => {
  const newer = new Set(covers.filter(space => answer.fetched > fetchedOf(known, space)))
  if (!newer.size)
    return known
  return {
    bookings: [...known.bookings.filter(booking => !newer.has(booking.space)), ...answer.bookings.filter(booking => newer.has(booking.space))],
    fetched:  { ...known.fetched, ...Object.fromEntries([...newer].map(space => [space, answer.fetched])) }
  }
}

/** A space's bookings among some: its own, and those of the space it's within not already said as its own, as Campus Rec lists a gym's under its courts too */
export const bookingsOf = (bookings: readonly Booking[], space: Pick<Space, "id" | "within">) => {
  const own = bookings.filter(booking => booking.space === space.id)
  return [...own, ...bookings.filter(booking => booking.space === space.within && !own.some(mine => mine.start === booking.start && mine.end === booking.end && mine.type === booking.type))]
}

//#endregion

//#region Free and busy

export type Span = { start: number, end: number }

/** How long a room must stay free to count as free */
export const FREE_FOR = 30 * 60_000

/** Spans joined where they overlap or touch, in order */
export const joined = (spans: readonly Span[]): Span[] => {
  const out: Span[] = []
  for (const { start, end } of spans.toSorted((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && start <= last.end)
      last.end = Math.max(last.end, end)
    else
      out.push({ start, end })
  }
  return out
}

/** How a room stands at an instant: busy till what's on ends, else free till the next thing starts, if anything does that day */
export type Standing = { isFree: false, until: number } | { isFree: true, until?: number }

export const standingAt = (busy: readonly Span[], at: number): Standing => {
  const spans = joined(busy)
  const under = spans.find(({ start, end }) => start <= at && at < end)
  if (under)
    return { isFree: false, until: under.end }
  const next = spans.find(({ start }) => start > at && start < dayStart(addDays(localDay(at), 1)))
  return next ? { isFree: true, until: next.start } : { isFree: true }
}

/** Whether a room stands free from an instant for as long as counts, or to the day's end */
export const isFreeFor = (standing: Standing, at: number) => {
  const dayEnd = dayStart(addDays(localDay(at), 1))
  return standing.isFree && (standing.until ?? dayEnd) - at >= Math.min(FREE_FOR, dayEnd - at)
}

/** The days a snapshot from a day covers: it and the six after */
export const weekFrom = (day: Day) =>
  Array.from({ length: 7 }, (_, i) => addDays(day, i))

/** Days the Worker asks 25Live about: from yesterday, as a late night's bookings run on, to a month ahead */
const ASK_BACK = 1
export const ASK_AHEAD = 30

export const isAskable = (day: Day, now: number) =>
  day >= addDays(localDay(now), -ASK_BACK) && day <= addDays(localDay(now), ASK_AHEAD)

//#endregion
