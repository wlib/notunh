// Instructors as people rather than as strings on sections, because the task that brings a student to one is "where
// will Professor X be next, and when": a name, the next scheduled class and its room, then Directions. The registrar
// lists a name and an address per section; the address tells two people of one name apart (Fall 2026 has a Jing
// Wang in Decision Sciences and another in Nursing), so the hidden address is the identity where there is one and
// the name where there isn't. What's said of a person is scheduled teaching from public section data, never
// whereabouts: the source doesn't say which of two listed instructors takes a given session, and knows nothing of
// office hours

import type { Calendar } from "./calendar.mts"
import { type CourseEvent, type Section, type Term, activeTerms, standing } from "./course.mts"

export type Person = {
  /** The hidden address where the registrar gives one, else the name, which is all there is to go on */
  id:       string,
  name:     string,
  mail?:    string,
  /** The sections this person is listed on, in the terms' order */
  teaching: { term: Term, section: Section }[]
}

/** Everyone listed on any section of the terms given, each once, with their teaching in the terms' order */
export const createPeople = (terms: readonly Term[]) => {
  const people = new Map<string, Person>()
  for (const term of terms)
    for (const section of term.sections)
      for (const { name, mail } of section.instructors) {
        const id = mail ?? name
        const person = people.get(id) ?? people.set(id, { id, name, ...mail ? { mail } : {}, teaching: [] }).get(id)!
        person.teaching.push({ term, section })
      }
  return [...people.values()]
}

/** A person's teaching in the terms live at an instant, which is what "next class" is asked of */
const live = (person: Person, now: number) => {
  const terms = new Set(activeTerms([...new Set(person.teaching.map(({ term }) => term))], now))
  return person.teaching.filter(({ term }) => terms.has(term))
}

/** A dated meeting with the section it's of */
export type Teaching = CourseEvent & { section: Section }

const sooner = (a: CourseEvent, b: CourseEvent) =>
  a.start < b.start || (a.start === b.start && a.crn < b.crn)

/**
 * Where a person is scheduled to teach: the class under way, if any, and the next to start, across every section
 * they're listed on in a live term. Cross-listed sections meet together, so the same physical class listed twice is
 * one answer: the earlier start wins, and at a tie the lower CRN, so the answer doesn't depend on the order the
 * sections or their meetings arrived in
 */
export const nextTeaching = (person: Person, calendar: Calendar, now: number, days = 21) => {
  let current: Teaching | undefined
  let next:    Teaching | undefined
  for (const { term, section } of live(person, now)) {
    const found = standing(term, section, calendar, now, days)
    if (found.current && (!current || sooner(found.current, current)))
      current = { ...found.current, section }
    if (found.next && (!next || sooner(found.next, next)))
      next = { ...found.next, section }
  }
  return { current, next }
}

/** The sections of a person's live teaching with a meeting under way or to come, soonest first: what a person's page lists */
export const upcoming = (person: Person, calendar: Calendar, now: number, days = 21) =>
  live(person, now)
    .map(({ term, section }) => ({ term, section, ...standing(term, section, calendar, now, days) }))
    .filter(({ current, next }) => current || next)
    .sort((a, b) => (a.current ?? a.next)!.start - (b.current ?? b.next)!.start || a.section.crn.localeCompare(b.section.crn))
