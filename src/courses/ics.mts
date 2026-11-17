// Classes as calendar entries (src/shared/ics.mts): each meeting of a section its session, so one VEVENT with a
// weekly rule to its last day, an EXDATE for each no-class day it would have met and each day swapped to another
// weekday, and a VEVENT more where a swapped day runs its weekday. A file of them is a snapshot: it won't follow a room
// change. A feed subscribed to does (worker/calendar.mts). Its events aren't the app's reminders. Pure

import type { Calendar } from "./calendar.mts"
import { type Section, type Term, KINDS, codeOf, courseOf, meetingKeys, sectionUrl, sessionOf } from "./course.mts"
import { type Entry, writeCalendar } from "../shared/ics.mts"
import { SITE } from "../shared/site.mts"

/** A section's meetings as entries, each named for good by its section and what it is; hours arranged have none */
export const entriesOf = (term: Pick<Term, "code">, section: Section, calendar: Calendar): Entry[] => {
  const keys = meetingKeys(section)
  return section.meetings.flatMap((meeting, i) => meeting.days ? [{
    uid:         `course-${term.code}-${section.crn}-${keys[i]}@notunh.app`,
    title:       `${courseOf(section)} ${KINDS[section.kind] ?? section.kind}`,
    description: `${codeOf(section)} ${section.title}${section.instructors.length ? ` · ${section.instructors.map(({ name }) => name).join(", ")}` : ""}`,
    where:       meeting.where,
    url:         `${SITE}${sectionUrl(term.code, section.crn)}`,
    session:     sessionOf(meeting, calendar)
  }] : [])
}

/** What a calendar of some sections is called, by their terms: "UNH Fall 2026" */
export const nameOf = (terms: readonly Pick<Term, "name">[]) =>
  `UNH ${[...new Set(terms.map(({ name }) => name))].join(", ") || "classes"}`

/** The file: every meeting of the sections given, under one calendar named for their terms, stamped with when it was written */
export const icsOf = (saved: readonly { term: Pick<Term, "code" | "name">, section: Section }[], calendar: Calendar, now = Date.now()) =>
  writeCalendar(nameOf(saved.map(({ term }) => term)), saved.flatMap(({ term, section }) => entriesOf(term, section, calendar)), now)
