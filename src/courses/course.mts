// Courses as the registrar publishes them and as the app reads them. The nouns are kept apart upstream and joined
// downstream: a Section is a term's offering (CRN, instructors, meeting patterns); a Meeting is one weekly pattern
// with its own days, times, dates and room; an occurrence is one dated meeting, which is the only thing that has a
// start, an end and a place, and so the only thing that becomes a row, a marker or a Directions target. The event
// shape (src/social/event.mts) is the projection of an occurrence, not what a section is: CS 518 meets in N343 on
// Tuesdays and in N113 on Fridays, and no single event can say so. Times are minutes after midnight on Durham's
// clock, as the timetable counts, and become instants only when a day is named
//
// A term ships as two files (scripts/map/courses.mts): the index, courses.json, which a page's head names and which
// carries the calendar and each live term's dates, freshness and file; and the term's sections, a file under
// /data/courses/ named by its content, loaded only when wanted (src/courses/browser/terms.mts)

import * as v from "valibot"
import { type Calendar, Calendar as CalendarSchema, emptyCalendar, letterOf } from "./calendar.mts"
import type { Event } from "../social/event.mts"
import { arrayOf } from "../shared/json.mts"
import { type Day, Day as DaySchema, addDays, atClock, daysBetween, localDay, weekday } from "../shared/time.mts"

/** A hidden address (email.mts) beside a name, or a name alone where the registrar lists none */
export const Instructor = v.object({ name: v.string(), mail: v.optional(v.string()) })
export type Instructor = v.InferOutput<typeof Instructor>

const Minute = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439))

export const Meeting = v.object({
  /** The weekdays, like "MWF", in M T W R F S U; empty for hours arranged */
  days:  v.string(),
  start: Minute,
  end:   Minute,
  /** The meeting's own dates, both included; a half-term lab needn't share the section's */
  from:  DaySchema,
  to:    DaySchema,
  /** A gazetteer name, or none for online, TBA, or a building the map doesn't know */
  place: v.optional(v.string()),
  /** The building and room as the registrar writes them: "Kingsbury N101", "On-line course", "TBA" */
  where: v.string()
})
export type Meeting = v.InferOutput<typeof Meeting>

export const Section = v.object({
  crn:         v.pipe(v.string(), v.regex(/^\d{5}$/)),
  subject:     v.string(),
  number:      v.string(),
  section:     v.string(),
  title:       v.string(),
  /** LEC, LAB, SEM, REC and the registrar's other schedule types (KINDS) */
  kind:        v.string(),
  /** IPFF in person, ONLA online asynchronous, ONLS synchronous, HYBL hybrid */
  mode:        v.string(),
  credits:     v.string(),
  /** The part of term's dates, both included */
  from:        DaySchema,
  to:          DaySchema,
  instructors: v.array(Instructor),
  meetings:    v.array(Meeting),
  /** CRNs of sections cross-listed with this one, which meet with it */
  crossListed: v.array(v.string())
})
export type Section = v.InferOutput<typeof Section>

/** Where the term files are served, each named by a hash of its contents */
export const DATA_PATH = "/data/courses/"

/** Where the build keeps the index, as scripts/map/courses.mts writes it and a page's head names it */
export const COURSES = "src/courses/courses.json"

/** A term as the index lists it: its dates, when its sections were read from the registrar, and its file */
export const TermEntry = v.object({
  code:     v.pipe(v.string(), v.regex(/^\d{4}[1357]0$/)),
  name:     v.string(),
  /** When classes run, both days included: the calendar's dates where it names them, else the sections' own */
  from:     DaySchema,
  to:       DaySchema,
  /** When the registrar answered for the term, by its own clock: its oldest page's timestamp. Freshness means this */
  fetched:  v.number(),
  /** How many sections the file has */
  sections: v.number(),
  /** The file's path, under DATA_PATH */
  file:     v.string()
})
export type TermEntry = v.InferOutput<typeof TermEntry>

/** The index: the calendar and the live terms, as the head names it */
export const CoursesIndex = v.object({
  /** When this file was written, which says nothing of how fresh it is */
  built:    v.number(),
  calendar: CalendarSchema,
  terms:    v.array(TermEntry),
  /** Every term file, which the service worker keeps with the index (Retain in src/shell/manifest.mts) */
  files:    v.array(v.string())
})
export type CoursesIndex = v.InferOutput<typeof CoursesIndex>

export const emptyIndex = (): CoursesIndex =>
  ({ built: 0, calendar: emptyCalendar(), terms: [], files: [] })

/** A term's file: its sections, taken on trust past being an array, as the build checked each against Section */
export const TermFile = v.object({ code: v.string(), sections: arrayOf<Section>() })
export type TermFile = v.InferOutput<typeof TermFile>

/** A term as everything else reads it: its entry with its sections in place of its file, and when the index was built */
export type Term = Omit<TermEntry, "file" | "sections"> & { built: number, sections: Section[] }

/** A term, from its index and its loaded file */
export const termOf = (index: Pick<CoursesIndex, "built">, { file, sections, ...entry }: TermEntry, data: TermFile): Term => {
  if (data.code !== entry.code || data.sections.length !== sections)
    throw new Error(`${file} isn't the term ${entry.code} the index names`)
  return { ...entry, built: index.built, sections: data.sections }
}

/** The names of the registrar's schedule types, as a row says them */
export const KINDS: Record<string, string> = {
  LEC: "Lecture", LAB: "Lab", SEM: "Seminar", REC: "Recitation", CLL: "Lecture/Lab", INV: "Independent study", THE: "Thesis",
  PRA: "Practicum", DD: "Dissertation", SPT: "Special topics", MUS: "Music", CPP: "Co-op", CLN: "Clinical", IE: "Internship",
  CLR: "Lecture/Recitation", PER: "Performance", RES: "Research", ADM: "Admin", COL: "Colloquium", DSA: "Study abroad",
  LAE: "Lab", A: "Arranged"
}

/** "CS 520 (01)" */
export const codeOf = ({ subject, number, section }: Pick<Section, "subject" | "number" | "section">) =>
  `${subject} ${number} (${section})`

/** "CS 520", the course a section is an offering of, which the catalog and the degree graph key on */
export const courseOf = ({ subject, number }: Pick<Section, "subject" | "number">) =>
  `${subject} ${number}`

/** A section's page */
export const sectionUrl = (term: string, crn: string) =>
  `/map/?section=${term}:${crn}`

/**
 * A section's own page in UNH's Course Search, which says what this leaves to it: its seats, and who it's restricted
 * to, majors, class and campus, as the registrar words them
 */
export const registrarUrl = (term: string, crn: string) =>
  `https://courses.unh.edu/class/${term}/${crn}`

/** Whether a section ever meets at a time the map can show */
export const meets = (section: Section) =>
  section.meetings.some(meeting => meeting.days.length > 0)

/** Minutes after midnight as "HH:MM", as atClock takes */
export const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`

/**
 * What names a meeting within its section, from what it is rather than where the registrar happened to list it, so
 * an identifier survives the source reordering its array: the days, the start, the room, and the first date
 */
const meetingKey = (meeting: Meeting) =>
  `${meeting.days}${clock(meeting.start).replace(":", "")}-${meeting.where.replace(/\W+/g, "")}-${meeting.from}`

/** Each meeting's key, made unique among its section's by a suffix where two are alike in everything keyed */
export const meetingKeys = (section: Section) => {
  const seen = new Map<string, number>()
  return section.meetings.map(meeting => {
    const key = meetingKey(meeting)
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return n ? `${key}-${n}` : key
  })
}

/** A dated meeting: the event shape, with its section and meeting behind it */
export type CourseEvent = Omit<Event, "source"> & { source: "course", term: string, crn: string, key: string }

/** Whether a meeting falls on a day: on the day's letter (letterOf), within its dates, and not a no-class day */
export const fallsOn = (meeting: Meeting, calendar: Calendar, day: Day, letter = letterOf(calendar, day, weekday(day))) =>
  meeting.days.includes(letter) && meeting.from <= day && day <= meeting.to && !calendar.noClass.includes(day)

/** A meeting on a day, as the event it is there, by its key among its section's (meetingKeys) */
export const eventOf = (term: Pick<Term, "code">, section: Section, meeting: Meeting, key: string, day: Day): CourseEvent => ({
  id:     `course:${term.code}:${section.crn}:${day}:${key}`,
  title:  `${courseOf(section)} · ${KINDS[section.kind] ?? section.kind}`,
  start:  atClock(day, clock(meeting.start)),
  end:    atClock(day, clock(meeting.end)),
  place:  meeting.place,
  where:  meeting.where,
  source: "course",
  url:    sectionUrl(term.code, section.crn),
  term:   term.code,
  crn:    section.crn,
  key
})

export const byStart = (a: CourseEvent, b: CourseEvent) =>
  a.start - b.start || a.end - b.end || a.id.localeCompare(b.id)

/**
 * A section's dated meetings on a Durham day: one per meeting that falls on it (fallsOn), soonest first. The id is
 * keyed by the meeting's content, so it's stable across builds and across the source reordering a section's
 * meetings, and Save, reminders and links survive a refetch
 */
export const occurrences = (term: Pick<Term, "code">, section: Section, calendar: Calendar, day: Day): CourseEvent[] => {
  const letter = letterOf(calendar, day, weekday(day))
  const keys = meetingKeys(section)
  return section.meetings
    .flatMap((meeting, i) => fallsOn(meeting, calendar, day, letter) ? [eventOf(term, section, meeting, keys[i], day)] : [])
    .sort(byStart)
}

/** Every dated meeting of a term's sections on a day, soonest first: what a day's list and a place's schedule read */
export const onDay = (term: Term, calendar: Calendar, day: Day, sections: readonly Section[] = term.sections) =>
  sections.flatMap(section => occurrences(term, section, calendar, day)).sort(byStart)

/**
 * Where a section stands at an instant: the meeting under way, if one is, and the next to start, looking up to
 * `days` ahead. They're kept apart because they answer different questions: "Happening now · ends 3:30" and "Next ·
 * Fri 2:10 N113". Someone catching an instructor wants the next start, not one already past; a Directions target for
 * a class under way is the one under way. Each day's meetings are taken soonest first, so the answer is the same in
 * whatever order the source lists them (CEE 400 (05) lists its 2:10 before its 12:10)
 */
export const standing = (term: Pick<Term, "code">, section: Section, calendar: Calendar, now: number, days = 21) => {
  let day = localDay(now)
  let current: CourseEvent | undefined
  for (let i = 0; i < days; i++, day = addDays(day, 1))
    for (const event of occurrences(term, section, calendar, day)) {
      if (event.start <= now && now < event.end)
        current ??= event
      else if (event.start > now)
        return { current, next: event }
    }
  return { current, next: undefined as CourseEvent | undefined }
}

/**
 * A term's dates: the calendar's where it names them, else the earliest and latest of its sections'. Fall ends in
 * December, J-Term runs in January and Spring starts late in January, so two terms are often live at once
 */
export const termSpan = (code: string, calendar: Calendar, sections: readonly Pick<Section, "from" | "to">[]) => {
  const dates = calendar.terms[code]
  return {
    from: dates?.start ?? sections.reduce((min, { from }) => from < min ? from : min, "9999-12-31"),
    to:   dates?.end ?? sections.reduce((max, { to }) => to > max ? to : max, "0000-01-01")
  }
}

/**
 * The terms worth loading at an instant, in the order given: those whose classes are running or begin within
 * `lead` days. None is "the" term, and a set of them answers every question asked of the courses
 */
export const activeTerms = <T extends { from: Day, to: Day },>(terms: readonly T[], now: number, lead = 14) => {
  const today = localDay(now)
  return terms.filter(({ from, to }) => daysBetween(today, from) <= lead && today <= to)
}
