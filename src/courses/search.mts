// Searching the live terms as the map searches places, from one field, answering in labelled groups rather than one
// sliced list: the people whose names match, the sections a code, CRN or title names, and the rooms a room query
// names. A code in any spelling ("CS 520", "cs520", "CS 520-01", "CHEM 403 NL1") is a code, five digits are a CRN,
// several are a pasted schedule, "N343", "Kingsbury N343" or "James 140" is a room, and anything else is fuzzy over
// titles and names (src/shared/fuzzy.mts). Terms are searched in the order given, live ones first, so a spring
// section never outranks today's

import { type Section, type Term, courseOf } from "./course.mts"
import type { Person } from "./people.mts"
import { fuzzySearch, latinize } from "../shared/fuzzy.mts"

const LIMIT = 8

/** A section with the term it's of, as a CRN is only unique within a term */
export type Found = { term: Term, section: Section }

export type Results = {
  people:   Person[],
  sections: Found[],
  /** The rooms a query names, each as the registrar writes it, its building, and what meets there */
  rooms:    { where: string, place: string, sections: Found[] }[]
}

/** "CS520-01", "cs 520 01" and "CS 520" as subject, number and maybe section, which may be "L03" or "NL1" as labs are numbered */
export const parseCode = (query: string) => {
  const [, subject, number, section] = query.trim().toUpperCase().match(/^([A-Z]{2,5})\s*-?\s*(\d{3}[A-Z]{0,2})(?:\s*[-\s(]?\s*([A-Z0-9]{1,3})\)?)?$/) ?? []
  return subject ? { subject, number, section: section && /^\d+$/.test(section) ? section.padStart(2, "0") : section } : undefined
}

/**
 * A room as a query names one: a letter-and-digits token like "N343", "G85" or "140", with or without its building
 * before it. "CS 520" has the shape too, which is why the search tries a code first and a room only when no section
 * answers to the code
 */
export const parseRoom = (query: string) => {
  const [, building, room] = query.trim().match(/^(?:([A-Za-z].*?)\s+)?([A-Za-z]{0,2}\d{2,4}[A-Za-z]?)$/) ?? []
  return room && !/^\d{5}$/.test(query.trim()) ? { building: building?.toLowerCase(), room: room.toUpperCase() } : undefined
}

/** The five-digit tokens of a text, as Banner's and WebCat's printouts carry CRNs */
const crnTokens = (text: string) =>
  [...new Set(text.match(/\b\d{5}\b/g) ?? [])]

/** The sections a pasted schedule names, each once, in the order pasted, the earlier term's where two share a CRN */
export const crnsIn = (pasted: string, terms: readonly Term[]): Found[] => {
  const byCrn = new Map<string, Found>()
  for (const term of terms.toReversed())
    for (const section of term.sections)
      byCrn.set(section.crn, { term, section })
  return crnTokens(pasted).flatMap(crn => byCrn.get(crn) ?? [])
}

export const createCourseSearch = (terms: readonly Term[], people: readonly Person[] = []) => {
  const found = terms.flatMap(term => term.sections.map(section => ({ term, section })))
  const titles = latinize(found.map(({ section }) => `${courseOf(section)} ${section.title}`))
  const names = latinize(people.map(person => person.name))
  const meetings = found.flatMap(item => item.section.meetings.filter(meeting => meeting.days && meeting.place).map(({ where, place }) => ({ where, place: place!, item })))
  const none: Results = { people: [], sections: [], rooms: [] }

  /** Whether a building as typed names a meeting's: the start of the registrar's words or the gazetteer's name, or its words in full */
  const isIn = (building: string, where: string, place: string) =>
    where.toLowerCase().startsWith(building) || place.toLowerCase().startsWith(building) || building.startsWith(where.toLowerCase().replace(/\s+\S+$/, ""))

  return (query: string): Results => {
    const needle = query.trim()
    if (!needle)
      return none
    const crns = crnTokens(needle)
    // CRNs alone, or several amid the rest of a pasted schedule
    if (crns.length > 1 || (crns.length && !needle.replace(/\b\d{5}\b|[\s,;]+/g, "")))
      return { ...none, sections: crnsIn(needle, terms) }
    const code = parseCode(needle)
    if (code) {
      const sections = found.filter(({ section }) => section.subject === code.subject && section.number.startsWith(code.number) && (!code.section || section.section.toUpperCase() === code.section))
      if (sections.length)
        return { ...none, sections: sections.slice(0, LIMIT) }
    }
    const room = parseRoom(needle)
    if (room) {
      const rooms = new Map<string, Results["rooms"][number]>()
      for (const { where, place, item } of meetings)
        if (where.toUpperCase().endsWith(` ${room.room}`) && (!room.building || isIn(room.building, where, place))) {
          const listed = rooms.get(where) ?? rooms.set(where, { where, place, sections: [] }).get(where)!
          if (!listed.sections.includes(item))
            listed.sections.push(item)
        }
      if (rooms.size)
        return { ...none, rooms: [...rooms.values()].slice(0, LIMIT) }
    }
    return {
      people:   fuzzySearch(names, needle).slice(0, LIMIT).map(({ index }) => people[index]),
      sections: fuzzySearch(titles, needle).slice(0, LIMIT).map(({ index }) => found[index]),
      rooms:    []
    }
  }
}
export type CourseSearch = ReturnType<typeof createCourseSearch>
