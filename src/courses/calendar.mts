// The academic calendar as the courses and the parking rules need it: the days no classes meet, the days that run
// another weekday's schedule, the university holidays, and each term's dates. It's read from 25Live Publisher's
// all-day "Academic Calendar" and "Holidays" entries, which the events leave out (src/social/sources.mts), by the
// pattern of their titles, so a title the registrar rewords falls out silently: scripts/map/courses.mts prints what
// it read for a human to look over once a term. Days are Durham days

import * as v from "valibot"
import { Live25Event, plain } from "../social/sources.mts"
import { usable } from "../shared/json.mts"
import { Day } from "../shared/time.mts"

/** A weekday as the registrar writes it, Monday first */
export const LETTERS = ["M", "T", "W", "R", "F", "S", "U"] as const
export const Letter = v.picklist(LETTERS)
export type Letter = v.InferOutput<typeof Letter>

export const TermDates = v.object({
  name:    v.string(),
  start:   v.optional(Day),
  end:     v.optional(Day),
  /** The finals window, both days included, where the calendar gives it */
  finals:  v.optional(v.tuple([Day, Day])),
  reading: v.array(Day)
})
export type TermDates = v.InferOutput<typeof TermDates>

export const Calendar = v.object({
  /** When 25Live was read, epoch ms */
  fetched:  v.number(),
  /** Days no classes meet: holidays, breaks, "no classes, offices open" */
  noClass:  v.array(Day),
  /** Days that follow another weekday's schedule, like a Tuesday that runs as a Wednesday */
  swaps:    v.record(Day, Letter),
  /** University holidays, when commuter and faculty lots open to all and meters are free */
  holidays: v.array(Day),
  /** By term code, like 202610 */
  terms:    v.record(v.string(), TermDates)
})
export type Calendar = v.InferOutput<typeof Calendar>

export const emptyCalendar = (): Calendar =>
  ({ fetched: 0, noClass: [], swaps: {}, holidays: [], terms: {} })

const SEASONS = { "10": "Fall", "30": "J-Term", "50": "Spring", "70": "Summer" } as const
export type Season = typeof SEASONS[keyof typeof SEASONS]

/**
 * A term's code from its season and the calendar year it's in. UNH codes by academic year, so Fall 2026 is 202610,
 * J-Term 2027 is 202630, Spring 2027 is 202650 and Summer 2027 is 202670
 */
export const termCode = (season: Season, year: number) =>
  season === "Fall" ? `${year}10` : `${year - 1}${Object.entries(SEASONS).find(([, name]) => name === season)![0]}`

/** A term's name, as courses.unh.edu writes it, from its code: "Fall 2026", "J-Term 2027" */
export const termName = (code: string) => {
  const year = +code.slice(0, 4)
  const half = code.slice(4) as keyof typeof SEASONS
  return `${SEASONS[half]} ${half === "10" ? year : year + 1}`
}

const WEEKDAYS: Record<string, Letter> = { monday: "M", tuesday: "T", wednesday: "W", thursday: "R", friday: "F", saturday: "S", sunday: "U" }

/** The calendar from 25Live's entries, any of its calendars, those of a shape not known left out */
export const fromLive25 = (json: unknown, fetched: number): Calendar => {
  const calendar = emptyCalendar()
  calendar.fetched = fetched
  const seen = new Set<string>()
  for (const { title: html, startDateTime, allDay, canceled, categoryCalendar = "" } of v.parse(usable(Live25Event), json)) {
    const title = plain(html, 200)
    const day = startDateTime.slice(0, 10)
    const key = `${day} ${title}`
    if (!allDay || canceled || seen.has(key) || !/Academic Calendar$|Holidays$/.test(categoryCalendar))
      continue
    seen.add(key)
    if (/University Holiday/.test(title) && categoryCalendar.endsWith("Holidays"))
      calendar.holidays.push(day)
    if (/^No Classes|No Classes$|Thanksgiving Holidays|Spring Recess|Midsemester Break/.test(title) && !/Law/.test(title))
      calendar.noClass.push(day)
    const swap = WEEKDAYS[title.match(/follow an? (\w+) Schedule/i)?.[1].toLowerCase() ?? ""]
    if (swap)
      calendar.swaps[day] = swap
    // "Fall 2026 Classes Begin", "Spring 2027 Last Day of Classes", but not Term 1's or Law's
    const [, season, year, rest] = title.match(/^(Fall|Spring|J-Term|Summer) (\d{4}) (.*)$/) ?? []
    if (!season)
      continue
    const dates = calendar.terms[termCode(season as Season, +year)] ??= { name: `${season} ${year}`, reading: [] }
    if (/^Classes Begin$/.test(rest))
      dates.start = day
    else if (/^(Classes End|Last Day of Classes)$/.test(rest))
      dates.end = day
    else if (/Final Exams? begin/i.test(rest))
      dates.finals = [day, dates.finals?.[1] ?? day]
    else if (/Final Exams? End/i.test(rest))
      dates.finals = [dates.finals?.[0] ?? day, day]
    if (/Reading Day/.test(rest))
      dates.reading.push(day)
  }
  const sorted = (days: string[]) => [...new Set(days)].sort()
  for (const dates of Object.values(calendar.terms))
    dates.reading = sorted(dates.reading)
  return { ...calendar, noClass: sorted(calendar.noClass), holidays: sorted(calendar.holidays) }
}

/** The weekday a day's classes follow: its own, 0 for Monday, or the one it's swapped to */
export const letterOf = (calendar: Pick<Calendar, "swaps">, day: Day, weekday: number): Letter =>
  calendar.swaps[day] ?? LETTERS[weekday]

/** The letters a registrar's days name, like "MWF" */
export const letters = (days: string) =>
  [...days].filter((letter): letter is Letter => v.is(Letter, letter))
