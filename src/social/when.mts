// What a line of text says of when, as UNH's pages and clubs write it: "Russian Conversation Hour: 2-3pm every
// Friday", "Tuesdays from 5:00-6:00 PM", "Mondays @ 7:30 PM", "12:40-1:40 Tuesdays", "every Thursday at noon",
// "Monday–Friday", "9/16, 9/30", "Nov. 4th". Our own patterns, shaped to how they're written rather than general: a
// range's start takes its end's meridiem unless that puts it after the end, bare numbers ("grades 1-6") aren't
// times, and a date without its year is in the year nearest the day it's read on. Read by the lead scanner
// (leads.mts) and the clubs' meeting times (sources.mts). Pure

import { type Day, addDays, daysBetween } from "../shared/time.mts"

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

/** A weekday as written, "Tuesdays", "Thurs.", "Fri", capitalized, or "weekdays" and "weekends" */
const WEEKDAY = /\b(?:(Mon|Tue|Tues|Wed|Weds|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day)?s?\b\.?|(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b|(weekday|weekend)s\b)/g

/** A time of day: "3", "12:40", "4:30 p.m.", "10am", with its meridiem where written */
const TIME = String.raw`(\d{1,2})(?::([0-5]\d))?(?:\s*([ap])\.?\s*m\b\.?)?`

/** A range of times, "3-4pm", "12:40-1:40", "9:00 AM to 5:00 PM", "noon-1pm" */
const RANGE = new RegExp(String.raw`(?<![\d/:])(?:${TIME}|(noon))\s*(?:-|–|—|to|until)\s*(?:${TIME}|(noon|midnight))`, "gi")

/** A time alone, which says it's a time: "at noon", "7pm", "7:30" */
const SINGLE = new RegExp(String.raw`(?<![\d/:])(?:(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?|(\d{1,2}):([0-5]\d)(?![\d/])|\b(noon|midnight)\b)`, "gi")

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** A date, "9/16", "10/28/2026", "November 20", "Nov. 4th" */
const DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])|\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g

/** Wording that says it's again and again */
const RECURRING = /\b(every|each|weekly|biweekly|monthly|alternating|every other|ongoing|all semester|throughout the semester)\b|\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)days\b/i

/** A time as "HH:MM", from its hours and minutes as written and a meridiem, where one's known */
const at = (hours: number, minutes: number, meridiem?: string) =>
  `${String(meridiem ? hours % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0) : hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`

/** A time with no meridiem read as a person would: 8 to 11 the morning, 12 noon, 1 to 7 the afternoon or evening */
const guessed = (hours: number) =>
  hours >= 8 && hours <= 11 ? "a" : "p"

/** A time of day a passage names, "HH:MM", and its end where it names one */
export type Window = { start: string, end?: string }

/** What a passage says of when: its weekdays (0 Monday), its times, its dates, and whether it's again and again */
export type When = { days: number[], times: Window[], dates: Day[], recurring: boolean }

/** A date as written, in the year that puts it nearest a day, as a page names the coming term's dates without one */
const dateOf = (month: number, date: number, year: number | undefined, near: Day): Day | undefined => {
  if (month < 1 || month > 12 || date < 1 || date > 31)
    return
  const of = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}` as Day
  const y = +near.slice(0, 4)
  const day = year ? of(year < 100 ? 2000 + year : year) : [y - 1, y, y + 1].map(of).sort((a, b) => Math.abs(daysBetween(near, a)) - Math.abs(daysBetween(near, b)))[0]
  // Not "February 30"
  return addDays(day, 0) === day ? day : undefined
}

/** What a passage says of when, as of a day, or none where it states no time of day with a day, a date or an end */
export const whenOf = (text: string, today: Day): When | undefined => {
  const times: Window[] = []
  const covered: [number, number][] = []
  for (const match of text.matchAll(RANGE)) {
    const [, h1, m1, a1, noon1, h2, m2, a2, noon2] = match
    // Numbers alone, "grades 1-6", "won 4-0", aren't times
    if (!a1 && !a2 && !m1 && !m2 && !noon1 && !noon2)
      continue
    const end = noon2 && (noon2.toLowerCase() === "noon" ? "12:00" : "24:00")
    const endMeridiem = a2 ?? (noon2 ? undefined : guessed(+h2))
    const endAt = end ?? at(+h2, +(m2 ?? 0), endMeridiem)
    let startAt = noon1 ? "12:00" : at(+h1, +(m1 ?? 0), a1 ?? endMeridiem ?? guessed(+h1))
    // "11-1pm" starts in the morning, as a start after its end would
    if (!noon1 && !a1 && startAt >= endAt)
      startAt = at(+h1, +(m1 ?? 0), "a")
    if (+h1 > 12 || +h2 > 12 || startAt >= endAt)
      continue
    times.push({ start: startAt, end: endAt })
    covered.push([match.index, match.index + match[0].length])
  }
  for (const match of text.matchAll(SINGLE)) {
    if (covered.some(([from, to]) => match.index >= from && match.index < to))
      continue
    const [, h, m, a, h24, m24, word] = match
    if (word)
      times.push({ start: word.toLowerCase() === "noon" ? "12:00" : "00:00" })
    else if (h && +h <= 12)
      times.push({ start: at(+h, +(m ?? 0), a) })
    else if (h24 && +h24 <= 12)
      times.push({ start: at(+h24, +m24, guessed(+h24)) })
  }
  const named = [...text.matchAll(WEEKDAY)].map(match => {
    const [, short, long, span] = match
    const days = span ? (span.toLowerCase() === "weekday" ? [0, 1, 2, 3, 4] : [5, 6]) : [DAY_NAMES.indexOf((short ?? long).slice(0, 3).toLowerCase())]
    return { days, from: match.index, to: match.index + match[0].length }
  })
  // "Monday–Friday", "Mon through Thu": each day between
  for (const [i, { days: [first], to }] of named.entries()) {
    const next = named[i + 1]
    if (next && /^\s*(-|–|—|through|thru|to)\s*$/.test(text.slice(to, next.from)))
      for (let day = first; day !== next.days[0]; day = (day + 1) % 7)
        named[i].days.push(day)
  }
  const days = [...new Set(named.flatMap(({ days }) => days))].sort()
  const dates = [...text.matchAll(DATE)].flatMap(([, month, date, year, name, dateNamed, namedYear]) => {
    const day = name
      ? dateOf(MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1, +dateNamed, namedYear ? +namedYear : undefined, today)
      : dateOf(+month, +date, year ? +year : undefined, today)
    return day ? [day] : []
  })
  const ranged = times.some(({ end }) => end)
  if (!times.length || !(ranged || days.length || dates.length))
    return
  return { days, times, dates, recurring: RECURRING.test(text) }
}

/** What a lead was read as, for someone to check: "Fri · 14:00–15:00 · 9/16, 9/30" */
export const whenText = ({ days, times, dates }: When) =>
  [
    days.map(day => DAY_NAMES[day][0].toUpperCase() + DAY_NAMES[day].slice(1)).join(", "),
    times.map(({ start, end }) => end ? `${start}–${end}` : start).join(", "),
    dates.join(", ")
  ].filter(Boolean).join(" · ")
