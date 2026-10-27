// Sections saved, and what's made of them: your next class for Yours, the week for You, and the visits a class
// reminder's queue resolves to (src/reminders/queue.mts). Saving keeps a section and nothing more: not enrolment, not
// alerts. A saved section is its term and CRN, "202610:12496", as a CRN is only unique within a term, kept as
// courses-saved, one of your things synced per person (src/shared/sync.mts). What's saved is read against the live
// terms, so a term past its end drops out by itself, and two sections cross-listed with each other meet together, so
// either saved is the one class

import type { Calendar } from "./calendar.mts"
import { LETTERS } from "./calendar.mts"
import { type CourseEvent, type Meeting, type Section, type Term, byStart, occurrences, standing } from "./course.mts"
import type { Found } from "./search.mts"
import { type Visit, visitOf } from "../shared/visit.mts"
import { type Day, addDays, localDay, weekday } from "../shared/time.mts"

/** Where the saved sections are kept */
export const SAVED = "courses-saved"

/** A section's key, "202610:12496", as it's saved and as its page's link names it */
export const keyOf = (term: string, crn: string) =>
  `${term}:${crn}`

/** A key's term and CRN, or none for anything else */
export const parseKey = (key: string) => {
  const [, term, crn] = key.match(/^(\d{4}[1357]0):(\d{5})$/) ?? []
  return term ? { term, crn } : undefined
}

/** What's stored, which an older version may have written: well-formed keys, each once, in order */
export const readSaved = (stored: unknown): string[] =>
  Array.isArray(stored) ? [...new Set(stored.filter((key): key is string => typeof key === "string" && parseKey(key) !== undefined))] : []

/** Whether two sections of a term are one class: the same section, or cross-listed with each other */
const isTwin = (a: Section, b: Section) =>
  a.crn === b.crn || a.crossListed.includes(b.crn) || b.crossListed.includes(a.crn)

/** The sections saved among the terms given, in the order saved, each class once: a key of a term not given drops out */
export const savedIn = (keys: readonly string[], terms: readonly Term[]): Found[] => {
  const found: Found[] = []
  for (const key of keys) {
    const { term: code, crn } = parseKey(key) ?? {}
    const term = terms.find(term => term.code === code)
    const section = term?.sections.find(section => section.crn === crn)
    if (term && section && !found.some(other => other.term === term && isTwin(other.section, section)))
      found.push({ term, section })
  }
  return found
}

/** Whether a section is saved, itself or a section cross-listed with it */
export const isSaved = (keys: readonly string[], { term, section }: Found) =>
  keys.some(key => {
    const parsed = parseKey(key)
    const other = parsed?.term === term.code ? term.sections.find(({ crn }) => crn === parsed.crn) : undefined
    return other !== undefined && isTwin(other, section)
  })

/** The keys with a section saved, unless it's saved already, itself or a section cross-listed with it */
export const withSaved = (keys: readonly string[], found: Found): string[] =>
  isSaved(keys, found) ? [...keys] : [...keys, keyOf(found.term.code, found.section.crn)]

/** The keys without a section, nor any section cross-listed with it */
export const withoutSaved = (keys: readonly string[], found: Found): string[] =>
  keys.filter(key => !isSaved([key], found))

/** A class on a day: its dated meeting, with the section and term it's of */
export type Dated = { event: CourseEvent, term: Term, section: Section }

/**
 * The classes of some sections on a Durham day, soonest first, each class once: a section cross-listed with another
 * listed meets with it, in the same room at the same time, so it's the one class
 */
export const datedOn = (found: readonly Found[], calendar: Calendar, day: Day): Dated[] => {
  const all = found
    .flatMap(({ term, section }) => occurrences(term, section, calendar, day).map(event => ({ event, term, section })))
    .sort((a, b) => byStart(a.event, b.event))
  return all.filter((item, i) => !all.slice(0, i).some(other =>
    other.term === item.term && other.event.start === item.event.start && other.event.where === item.event.where && isTwin(other.section, item.section)))
}

/** The classes of some sections from an instant on, to `days` days ahead, each class once, those over left out */
export const datedFrom = (found: readonly Found[], calendar: Calendar, now: number, days = 7): Dated[] =>
  Array.from({ length: days }, (_, i) => addDays(localDay(now), i))
    .flatMap(day => datedOn(found, calendar, day))
    .filter(({ event }) => event.end > now)

/** A week of classes, Monday first, from the week a day is in: each day with its classes */
export const weekOf = (found: readonly Found[], calendar: Calendar, day: Day) => {
  const monday = addDays(day, -weekday(day))
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map(day => ({ day, classes: datedOn(found, calendar, day) }))
}

/** The next of some sections' classes to start after an instant, looking up to `days` ahead, or none */
export const nextOf = (found: readonly Found[], calendar: Calendar, now: number, days = 21): Dated | undefined =>
  found
    .flatMap(({ term, section }) => {
      const { next } = standing(term, section, calendar, now, days)
      return next ? [{ event: next, term, section }] : []
    })
    .sort((a, b) => byStart(a.event, b.event))[0]

/** The last day a section meets, which a meeting may run past the section's own dates to */
const lastDay = (section: Section) =>
  section.meetings.reduce((last, { to }) => to > last ? to : last, section.to)

/**
 * The courses as a class reminder's queue resolves them: by a section's key, its meetings still to come as of an
 * instant, soonest first, to its last, as visits at no offset, those at no place the map knows left out. A section
 * not among the terms gives none, which ends its queue
 */
export const resolverOf = (terms: readonly Term[], calendar: Calendar, now: () => number) => (key: string): Visit[] => {
  const [found] = savedIn([key], terms)
  if (!found)
    return []
  const at = now()
  const visits: Visit[] = []
  for (let day = localDay(at), last = lastDay(found.section); day <= last; day = addDays(day, 1))
    for (const event of occurrences(found.term, found.section, calendar, day))
      if (event.start > at && event.place)
        visits.push(visitOf(event)!)
  return visits
}

/** Where a registrar's day letter falls in the week, Monday first */
const indexOf = (letter: string) =>
  LETTERS.indexOf(letter as typeof LETTERS[number])

/** A meeting's weekdays, 0 for Monday, as Weekdays (src/shell/intl.tsx) names them: "TR" is Tuesday and Thursday */
export const daysOf = (days: string) =>
  [...days].map(indexOf).filter(day => day >= 0)

/**
 * A section's weekly meetings, as its Weekly lines say them: those with days, each pattern once whatever its dates,
 * in the order of the week, so CS 518's Tuesday and Thursday in N343 is one line and its Friday in N113 another
 */
export const patternsOf = (section: Section): Meeting[] => {
  const patterns = new Map<string, Meeting>()
  for (const meeting of section.meetings) {
    const key = `${meeting.days} ${meeting.start} ${meeting.end} ${meeting.where}`
    if (meeting.days && !patterns.has(key))
      patterns.set(key, meeting)
  }
  return [...patterns.values()].sort((a, b) => indexOf(a.days[0]) - indexOf(b.days[0]) || a.start - b.start)
}
