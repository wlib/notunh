// What's scheduled at a building or in a room, now and on a day, for "Classes now" on a place and for a room's
// page. Indexed once for the live terms by place and by room, so a tap costs a few dozen comparisons rather than a
// pass over every section. A room holds one class at a time, and cross-listed sections meet together, so two
// sections of each other's cross-list in the same room at the same time are one class, under the first by CRN with
// the others in `also`

import { type Calendar, letterOf } from "./calendar.mts"
import { type CourseEvent, type Meeting, type Section, type Term, eventOf, fallsOn, meetingKeys } from "./course.mts"
import { type Day, localDay, weekday } from "../shared/time.mts"

/** One class at a place: a dated meeting with its section and meeting, and the sections cross-listed into it */
export type Scheduled = { term: Term, section: Section, meeting: Meeting, event: CourseEvent, also: Section[] }

/** A building by its gazetteer name, or a room as the registrar writes it, "Kingsbury N343" */
export type Where = { place: string } | { room: string }

/** A room as compared: its words in capitals, single-spaced */
export const roomKey = (where: string) =>
  where.trim().replace(/\s+/g, " ").toUpperCase()

/** The scheduled classes with each physical class once: a section cross-listed with an earlier one in the same room and time joins it */
export const dedupe = <T extends Pick<Scheduled, "section" | "meeting" | "also">,>(scheduled: readonly T[]): T[] => {
  const kept: T[] = []
  for (const item of scheduled) {
    const twin = kept.find(other =>
      other.meeting.where === item.meeting.where &&
      other.meeting.start === item.meeting.start &&
      other.meeting.end === item.meeting.end &&
      (other.section.crossListed.includes(item.section.crn) || item.section.crossListed.includes(other.section.crn)))
    if (twin)
      twin.also.push(item.section)
    else
      kept.push(item)
  }
  return kept
}

type Entry = { term: Term, section: Section, meeting: Meeting, key: string }

/** The live terms' timed, placed meetings, by building and by room, to ask what's on there */
export const createSchedule = (terms: readonly Term[], calendar: Calendar) => {
  const byPlace = new Map<string, Entry[]>()
  const byRoom = new Map<string, Entry[]>()
  const add = (index: Map<string, Entry[]>, key: string, entry: Entry) =>
    (index.get(key) ?? index.set(key, []).get(key)!).push(entry)
  for (const term of terms)
    for (const section of term.sections) {
      const keys = meetingKeys(section)
      for (const [i, meeting] of section.meetings.entries())
        if (meeting.place && meeting.days) {
          const entry = { term, section, meeting, key: keys[i] }
          add(byPlace, meeting.place, entry)
          add(byRoom, roomKey(meeting.where), entry)
        }
    }
  const entriesAt = (where: Where) =>
    ("place" in where ? byPlace.get(where.place) : byRoom.get(roomKey(where.room))) ?? []

  /** The classes there on a day that pass a test, each once, in an order */
  const scheduled = (where: Where, day: Day, keep: (event: CourseEvent) => boolean, order: (a: Scheduled, b: Scheduled) => number) => {
    const letter = letterOf(calendar, day, weekday(day))
    return dedupe(entriesAt(where)
      .filter(({ meeting }) => fallsOn(meeting, calendar, day, letter))
      .map(({ term, section, meeting, key }) => ({ term, section, meeting, event: eventOf(term, section, meeting, key, day), also: [] as Section[] }))
      .filter(({ event }) => keep(event))
      .sort(order))
  }

  /** What's scheduled there on a day, each class once, soonest first */
  const on = (where: Where, day: Day): Scheduled[] =>
    scheduled(where, day, () => true, (a, b) => a.event.start - b.event.start || a.event.end - b.event.end || a.section.crn.localeCompare(b.section.crn))

  /** What's under way there at an instant, each class once, soonest to end first */
  const now = (where: Where, at: number): Scheduled[] =>
    scheduled(where, localDay(at), event => event.start <= at && at < event.end, (a, b) => a.event.end - b.event.end || a.section.crn.localeCompare(b.section.crn))

  /** The rooms of a building anything is ever scheduled in, as the registrar writes them, in order */
  const roomsIn = (place: string) =>
    [...new Set((byPlace.get(place) ?? []).map(({ meeting }) => meeting.where))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))

  return { on, now, roomsIn }
}
export type Schedule = ReturnType<typeof createSchedule>
