// The academic calendar as the courses and the parking rules need it: the days no classes meet, the days that run
// another weekday's schedule, the university holidays, and each term's dates. It's read from 25Live Publisher's
// all-day "Academic Calendar" and "Holidays" entries, which the events leave out (src/social/sources.mts), by the
// pattern of their titles, so a title the registrar rewords falls out silently: scripts/map/courses.mts prints what
// it read for a human to look over once a term. Days are Durham days

import * as v from "valibot"
import { Live25Event, plain } from "../social/sources.mts"
import { usable } from "../shared/json.mts"
import { type Rule, WEEKDAYS, any, between, daily, except, occurrences, on, weekly } from "../shared/recur.mts"
import { plainDay } from "../shared/temporal.mts"
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

/**
 * What kind of date the academic calendar names: a deadline, registration opening or closing, a break, or a term's
 * start, end or finals
 */
export const DATE_KINDS = ["deadline", "registration", "break", "term"] as const

/** Undergraduates' class standings, as registration opens to each in turn */
export const STANDINGS = ["first-year", "sophomore", "junior", "senior"] as const
export type Standing = typeof STANDINGS[number]

/**
 * A date worth knowing ahead, as the registrar words it, but for whom it's not about; a registration window says who
 * it's for first, "Seniors · registration opens", with the term and time after
 */
export const KeyDate = v.object({
  day:      Day,
  title:    v.string(),
  kind:     v.picklist(DATE_KINDS),
  audience: v.optional(v.picklist(STANDINGS)),
  detail:   v.optional(v.string())
})
export type KeyDate = v.InferOutput<typeof KeyDate>

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
  terms:    v.record(v.string(), TermDates),
  /** Deadlines, registration, breaks and the terms' dates, by day, for Durham's undergraduates; none from before they were kept */
  dates:    v.optional(v.array(KeyDate), [])
})
export type Calendar = v.InferOutput<typeof Calendar>

export const emptyCalendar = (): Calendar =>
  ({ fetched: 0, noClass: [], swaps: {}, holidays: [], terms: {}, dates: [] })

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

/** Dates for someone other than Durham's undergraduates, or for staff, which a student needn't be told */
const NOT_OURS = /UNH Law|CPS Online|TSAS|Faculty|Census|Early Alert|Degree Conferral|Term \d\b|\bgrad(?:uate)?\b|Ph\.D|Continuing Education|without Webcat|Midsemester$|Webcat registration continues/i

/** The kind of date a title names, or none for one that isn't worth knowing ahead */
const kindOf = (title: string): KeyDate["kind"] | undefined =>
  /registration (begins|closes|reopens)/i.test(title)                      ? "registration" :
  /Classes Begin|Last Day of Classes|Final Exams|Classes Resume/i.test(title) ? "term" :
  /LAST DAY|deadline|Due date/i.test(title)                                ? "deadline" :
  /^No Classes|Thanksgiving|Recess|Midsemester Break/i.test(title)         ? "break" :
                                                                             undefined

/** Each standing as the registrar names it, and as a list says it */
const AUDIENCES: [RegExp, Standing, string][] = [
  [/\bSENIORS?\b/i, "senior", "Seniors"],
  [/\bJUNIORS?\b/i, "junior", "Juniors"],
  [/\bSOPHOMORES?\b/i, "sophomore", "Sophomores"],
  [/\bFRESHM[AE]N\b|first[- ]year/i, "first-year", "First-years"]
]

/**
 * A registration window as a list says it, who it's for first: "Spring 2027 registration begins for Durham and
 * Manchester SENIORS at 8:30am" is "Seniors · registration opens", "Spring 2027 · 8:30am"
 */
const windowOf = (title: string): Pick<KeyDate, "title" | "audience" | "detail"> | undefined => {
  const found = AUDIENCES.find(([words]) => words.test(title))
  const [, term, action, time] = title.match(/^(\w+ \d{4}) registration (begins|closes|reopens)\b.*?(?: at ([\d:]+\s*[ap]m))?$/i) ?? []
  if (!found || !term)
    return
  const [, audience, said] = found
  return { title: `${said} · registration ${action.toLowerCase() === "closes" ? "closes" : "opens"}`, audience, detail: [term, time].filter(Boolean).join(" · ") }
}

/** A title as a list says it: the registrar's capitals and "Durham and Manchester" let go */
const titleOf = (title: string) =>
  title.replace(/LAST DAY/g, "Last day").replace(/ (for )?(current )?Durham (and|&) Manchester/g, "").replace(/\b(SENIORS|JUNIORS|SOPHOMORES|FRESHMEN|FRESHMAN)\b/g, word => word.toLowerCase()).replace(/ \((Durham\/Manchester Courses|See event details[^)]*)\)/g, "")

const NAMED: Record<string, Letter> = { monday: "M", tuesday: "T", wednesday: "W", thursday: "R", friday: "F", saturday: "S", sunday: "U" }

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
    const kind = categoryCalendar.endsWith("Academic Calendar") && !NOT_OURS.test(title) ? kindOf(title) : undefined
    if (kind) {
      const opening = kind === "registration" ? windowOf(title) : undefined
      calendar.dates.push({ day, kind, ...opening ?? { title: titleOf(title) } })
    }
    if (/University Holiday/.test(title) && categoryCalendar.endsWith("Holidays"))
      calendar.holidays.push(day)
    if (/^No Classes|No Classes$|Thanksgiving Holidays|Spring Recess|Midsemester Break/.test(title) && !/Law/.test(title))
      calendar.noClass.push(day)
    const swap = NAMED[title.match(/follow an? (\w+) Schedule/i)?.[1].toLowerCase() ?? ""]
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
  return { ...calendar, noClass: sorted(calendar.noClass), holidays: sorted(calendar.holidays), dates: calendar.dates.sort((a, b) => a.day.localeCompare(b.day)) }
}

/**
 * Those of some days from a day that classes meet on, as clubs do too: within a term that's begun, not past its last
 * day of classes where the calendar names one, and not a day without classes
 */
export const classDays = ({ noClass, terms }: Pick<Calendar, "noClass" | "terms">, from: Day, days: number): Day[] =>
  occurrences(
    except(any(...Object.values(terms).flatMap(({ start, end }) => start ? [between(start, end, daily)] : [])), on(...noClass)),
    plainDay(from),
    days
  ).map(String)

const meetingDays = new WeakMap<object, Map<string, Rule>>()

/**
 * The days classes meeting on some weekdays, "MWF", meet, as a rule with no first or last day: those weekdays and
 * the days swapped to one of them, but the days without classes and the days swapped to another weekday. Made once
 * for a calendar and its weekdays, as every meeting of a term asks
 */
export const meetingRule = (calendar: Pick<Calendar, "noClass" | "swaps">, days: string): Rule => {
  const made = meetingDays.get(calendar) ?? meetingDays.set(calendar, new Map()).get(calendar)!
  if (!made.has(days)) {
    const swapped = Object.entries(calendar.swaps)
    made.set(days, except(
      any(weekly(...letters(days).map(letter => WEEKDAYS[LETTERS.indexOf(letter)])), on(...swapped.flatMap(([day, letter]) => days.includes(letter) ? [day] : []))),
      on(...calendar.noClass, ...swapped.flatMap(([day, letter]) => days.includes(letter) ? [] : [day]))
    ))
  }
  return made.get(days)!
}

/** The letters a registrar's days name, like "MWF" */
export const letters = (days: string) =>
  [...days].filter((letter): letter is Letter => v.is(Letter, letter))
