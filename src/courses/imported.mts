// A calendar someone imports, a file or a feed from Canvas, Google or Outlook, so their own classes and events show
// beside the app's: each VEVENT read as a session (src/shared/ics.mts), kept as little as shows it, a title, where, and
// when by its own zone's clock. Whole-day entries, as due dates and birthdays are, aren't read, and what's long over is
// left out, as neither is somewhere to be at a time. It's personal: kept on the device alone
// (src/map/state/calendars.mts), never sent to the Worker, synced or logged
//
// An imported event is matched, each time it's shown, to what the app knows: the section it's a meeting of, by the
// course code in its title ("CS 518", "[CS518.01-FA26]" as Canvas writes it), its section number where it gives
// one, else whichever section of the course meets when it does; with no code, the section meeting in the room it
// names at that time; and the place its where names, else its section's. Pure

import * as v from "valibot"
import type { Calendar } from "./calendar.mts"
import { type Meeting, type Section, type Term, sessionOf } from "./course.mts"
import { roomKey } from "./rooms.mts"
import { isTwin } from "./saved.mts"
import type { Found } from "./search.mts"
import type { Matcher } from "../social/sources.mts"
import { getOrCreate } from "../shared/group.mts"
import { readEvents } from "../shared/ics.mts"
import { Session, boundsOf, occursOn, spansOf } from "../shared/recur.mts"
import { dayAt, instantAt, plainDay } from "../shared/temporal.mts"
import { type Day, TIME_ZONE, localMinutes } from "../shared/time.mts"

/** Where the imported calendars are kept, on this device alone */
export const KEY = "calendars"

/** The most events kept of one calendar, and characters of a title or a where */
export const MAX_EVENTS = 2000
const TEXT = 120

/** An event of an imported calendar: what, where as written, and when, by the clock of the zone it's in */
export const Imported = v.object({
  uid:     v.string(),
  title:   v.string(),
  where:   v.string(),
  zone:    v.string(),
  session: Session
})
export type Imported = v.InferOutput<typeof Imported>

/** An imported calendar as kept: its name, the address it's read from again where it came from one, when it was read, and its events */
export const Kept = v.object({
  id:     v.string(),
  name:   v.string(),
  url:    v.optional(v.string()),
  at:     v.number(),
  events: v.array(Imported)
})
export type Kept = v.InferOutput<typeof Kept>

/** What's stored, which an older version may have written: the calendars that still read as ones */
export const readKept = (stored: unknown): Kept[] =>
  Array.isArray(stored) ? stored.filter((one): one is Kept => v.is(Kept, one)) : []

/** A calendar file's name for itself, where it gives one */
export const calendarName = (ics: string) =>
  ics.replace(/\r?\n[ \t]/g, "").match(/^X-WR-CALNAME(?:;[^:]*)?:(.+)$/m)?.[1].replace(/\\(.)/g, "$1").trim().slice(0, TEXT)

/** A calendar file's events worth keeping as of a day: those at a time, with a title, not over before yesterday */
export const importedFrom = (ics: string, today: Day): Imported[] => {
  const cutoff = plainDay(today).subtract({ days: 1 }).toString()
  return readEvents(ics)
    .filter(({ title, session }) => title && (boundsOf(session.rule).until ?? cutoff) >= cutoff)
    .slice(0, MAX_EVENTS)
    .map(({ uid, title, where, zone, session }) => ({ uid, title: title.slice(0, TEXT), where: where.slice(0, TEXT), zone, session }))
}

/** An imported event on a day: itself, from its start to its end in epoch ms */
export type DatedImport = { event: Imported, start: number, end: number }

/** The events starting on some Durham days from one, soonest first, whatever zone each is in */
export const importedOn = (events: readonly Imported[], from: Day, days: number): DatedImport[] => {
  const first = plainDay(from)
  const [opens, closes] = [instantAt(first, "00:00"), instantAt(first.add({ days }), "00:00")]
  // A day elsewhere starts up to a day before or after Durham's
  return events
    .flatMap(event => spansOf(event.session, first.subtract({ days: 1 }), days + 2, event.zone).map(({ start, end }) => ({ event, start, end })))
    .filter(({ start }) => start >= opens && start < closes)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

//#region Matching

/** What an imported event is of, where the app knows: the section it's a meeting of, and the place it's at */
export type Match = { found?: Found, place?: string }

/** How near a class's start an event's must be to be that class, in minutes */
const NEAR = 15

/**
 * Whether an imported event on a day is a class told already: its section's, or one's cross-listed with it, starting
 * about when the event does
 */
export const isClassAt = ({ start, match }: DatedImport & { match: Match }, section: Section, at: number) =>
  match.found !== undefined && isTwin(match.found.section, section) && Math.abs(at - start) <= NEAR * 60_000

/** How many days from the day asked an event's occurrences are compared with the classes meeting then */
const SAMPLED_DAYS = 28

/** A course code in a title, and a section after it where there's one: "CS 518", "CS518.01", "CHEM 403-L02" */
const CODE = /\b([A-Z]{2,5})[\s-]?(\d{3}[A-Z]{0,2})(?:[.\-\s(]+([A-Z]{0,2}\d{1,2})\b)?/g

/** A room's number as a where names it: "N343", "210", "G10" */
const ROOM = /\b([A-Za-z]{0,2}\d{2,4}[A-Za-z]?)\b/g

const roomIn = (place: string, room: string) =>
  `${place}|${room.toUpperCase()}`

/**
 * Matches imported events against some terms' sections, as the academic calendar has them meet, and the places a
 * matcher knows. Each match is made by when the event really is: its occurrences over the weeks from a day, on
 * Durham's clock, beside the classes meeting those days. A where in the registrar's own words, "Kingsbury N343", is
 * the room it names there, before the matcher is asked what building other words mean
 */
export const createMatcher = (terms: readonly Term[], calendar: Calendar, match: Matcher) => {
  const byCourse = new Map<string, Found[]>()
  const byRoom = new Map<string, { found: Found, meeting: Meeting }[]>()
  const placeOfWhere = new Map<string, string>()
  for (const term of terms)
    for (const section of term.sections) {
      getOrCreate(byCourse, `${section.subject} ${section.number}`, () => []).push({ term, section })
      for (const meeting of section.meetings)
        if (meeting.place && meeting.days) {
          getOrCreate(byRoom, roomIn(meeting.place, meeting.where.split(" ").at(-1)!), () => []).push({ found: { term, section }, meeting })
          placeOfWhere.set(roomKey(meeting.where), meeting.place)
        }
    }

  type Span = { day: ReturnType<typeof dayAt>, minutes: number }

  /** Whether a meeting is what an event is: it meets on a day the event's on, starting about when it does */
  const isAt = (meeting: Meeting, spans: readonly Span[]) =>
    meeting.days.length > 0 && spans.some(({ day, minutes }) => Math.abs(meeting.start - minutes) <= NEAR && occursOn(day)(sessionOf(meeting, calendar).rule))

  return (event: Imported, from: Day): Match => {
    const spans = importedOn([event], from, SAMPLED_DAYS).map(({ start }) => ({ day: dayAt(start, TIME_ZONE), minutes: localMinutes(start) }))
    const meetingOf = ({ section }: Found) => section.meetings.find(meeting => isAt(meeting, spans))
    const place = placeOfWhere.get(roomKey(event.where)) ?? match(event.where)
    const coded = [...event.title.toUpperCase().matchAll(CODE)].flatMap(([, subject, number, section]) => {
      const sections = byCourse.get(`${subject} ${number}`) ?? []
      const named = section === undefined ? [] : sections.filter(found => found.section.section === (/^\d+$/.test(section) ? section.padStart(2, "0") : section))
      return named.length ? named.find(meetingOf) ?? named[0] : sections.find(meetingOf) ?? (sections.length === 1 ? sections : [])
    })
    const roomed = place === undefined ? [] : [...event.where.matchAll(ROOM)].flatMap(([, room]) =>
      (byRoom.get(roomIn(place, room)) ?? []).flatMap(({ found, meeting }) => isAt(meeting, spans) ? [found] : []))
    const [found] = [...coded, ...roomed]
    const at = place ?? (found && (meetingOf(found) ?? found.section.meetings.find(meeting => meeting.place))?.place)
    return { ...found && { found }, ...at !== undefined && { place: at } }
  }
}

//#endregion

/** How long a calendar read from an address is good for, before it's read again */
export const STALE_MS = 6 * 3_600_000

/** A calendar read, as it's kept: by its address where it has one, so reading it again replaces it, else by a name made for it */
export const keptOf = (ics: string, { url, name }: { url?: string, name?: string }, now: number): Kept => ({
  id:     url ?? `file-${now}`,
  name:   calendarName(ics) ?? name ?? "Calendar",
  ...url && { url },
  at:     now,
  events: importedFrom(ics, dayAt(now).toString())
})

/** The calendars with one added, in place of the one it replaces where it's been read before */
export const withKept = (calendars: readonly Kept[], one: Kept): Kept[] =>
  calendars.some(({ id }) => id === one.id) ? calendars.map(other => other.id === one.id ? one : other) : [...calendars, one]
