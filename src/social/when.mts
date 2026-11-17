// What a line of text says of when, as UNH's pages, its clubs and Campus Rec write it: "Russian Conversation Hour:
// 2-3pm every Friday", "Tuesdays from 5:00-6:00 PM", "Mondays @ 7:30 PM", "12:40-1:40 Tuesdays", "every Thursday at
// noon", "Monday–Friday", "9/16, 9/30", "Nov. 4th". Our own patterns, shaped to how they're written rather than
// general: a range's start takes its end's meridiem unless that puts it after the end, bare numbers ("grades 1-6")
// aren't times, and a date without its year is in the year nearest the day it's read on. The one reader of times, for
// the lead scanner (leads.mts), the clubs' meeting times and Campus Rec's offerings (sources.mts). Pure

import { type Day, addDays, daysBetween } from "../shared/time.mts"

/** The weekdays as they're kept and shown, Monday first, as weekday() counts them */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

/** A weekday as written, "Tuesdays", "Thurs.", "Fri", capitalized, or "weekdays" and "weekends" */
const WEEKDAY = /\b(?:(Mon|Tue|Tues|Wed|Weds|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day)?s?\b\.?|(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b|(weekday|weekend)s\b)/g

/** A time of day: "3", "12:40", "4:30 p.m.", "10am", with its meridiem where written */
const TIME = String.raw`(\d{1,2})(?::([0-5]\d))?(?:\s*([ap])\.?\s*m\b\.?)?`

/** A range of times, "3-4pm", "12:40-1:40", "9:00 AM to 5:00 PM", "noon-1pm" */
const RANGE = new RegExp(String.raw`(?<![\d/:])(?:${TIME}|(noon))\s*(?:-|–|—|to|until)\s*(?:${TIME}|(noon|midnight))`, "gi")

/** A time alone, which says it's a time: "at noon", "7pm", "7:30" */
const SINGLE = new RegExp(String.raw`(?<![\d/:])(?:(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?|(\d{1,2}):([0-5]\d)(?![\d/])|\b(noon|midnight)\b)`, "gi")

/** A month as written, "November", "Nov", "Sept" */
export const MONTH = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?"

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** A date, "9/16", "10/28/26", "10/28/2026", "November 20", "Nov. 4th", "Nov 20 2026" */
const DATE = new RegExp(String.raw`(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d\d))?(?![\d/])|\b(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, "g")

/** Wording that says it's again and again */
const RECURRING = /\b(every|each|weekly|biweekly|monthly|alternating|every other|ongoing|all semester|throughout the semester)\b|\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)days\b/i

/** A time as "HH:MM", from its hours and minutes as written and a meridiem, where one's known */
const at = (hours: number, minutes: number, meridiem?: string) =>
  `${String(meridiem ? hours % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0) : hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`

/** A time with no meridiem read as a person would: 8 to 11 the morning, 12 noon, 1 to 7 the afternoon or evening */
const guessed = (hours: number) =>
  hours >= 8 && hours <= 11 ? "a" : "p"

/** A time of day a text states, "HH:MM", and its end where it states one */
export type Window = { start: string, end?: string }

/** What a passage says of when: its weekdays (0 Monday), its times, its dates, and whether it's again and again */
export type When = { days: number[], times: Window[], dates: Day[], recurring: boolean }

/**
 * The times of day a text states, its ranges before its times alone, each in the order written, and the rest of the
 * text without them. A range that doesn't end after it starts, "10pm-1am", runs past midnight, and is read as two
 * times
 */
export const timesOf = (text: string) => {
  const found: { from: number, to: number, time: Window }[] = []
  for (const match of text.matchAll(RANGE)) {
    const [, h1, m1, a1, noon1, h2, m2, a2, noon2] = match
    // Numbers alone, "grades 1-6", "won 4-0", aren't times
    if (!a1 && !a2 && !m1 && !m2 && !noon1 && !noon2 || +h1 > 12 || +h2 > 12)
      continue
    const endMeridiem = a2 ?? (noon2 ? undefined : guessed(+h2))
    const end = noon2 ? (noon2.toLowerCase() === "noon" ? "12:00" : "24:00") : at(+h2, +(m2 ?? 0), endMeridiem)
    let start = noon1 ? "12:00" : at(+h1, +(m1 ?? 0), a1 ?? endMeridiem ?? guessed(+h1))
    // "11-1pm" starts in the morning, as a start after its end would
    if (!noon1 && !a1 && start >= end)
      start = at(+h1, +(m1 ?? 0), "a")
    if (start < end)
      found.push({ from: match.index, to: match.index + match[0].length, time: { start, end } })
    // "9-1am" starts in the evening, which its start alone wouldn't say; its end is read below, as a time alone
    else if (!noon1 && !a1 && a2)
      found.push({ from: match.index, to: match.index + h1.length + (m1 ? 3 : 0), time: { start: at(+h1, +(m1 ?? 0), "p") } })
  }
  for (const match of text.matchAll(SINGLE)) {
    const [, h, m, a, bare, bareMinutes, word] = match
    if (found.some(({ from, to }) => match.index >= from && match.index < to) || +(h ?? bare ?? 0) > 12)
      continue
    const start =
      word ? (word.toLowerCase() === "noon" ? "12:00" : "00:00") :
      h    ? at(+h, +(m ?? 0), a) :
      at(+bare, +bareMinutes, guessed(+bare))
    found.push({ from: match.index, to: match.index + match[0].length, time: { start } })
  }
  return {
    times: found.sort((a, b) => +!a.time.end - +!b.time.end || a.from - b.from).map(({ time }) => time),
    rest:  found.sort((a, b) => b.from - a.from).reduce((rest, { from, to }) => rest.slice(0, from) + rest.slice(to), text)
  }
}

/** The weekdays a text names (0 Monday), each once, in order: "Tuesdays", "weekends", each day of "Monday–Friday" */
const weekdaysOf = (text: string) => {
  const named = [...text.matchAll(WEEKDAY)].map(match => {
    const [, short, long, span] = match
    const days = span ? (span === "weekday" ? [0, 1, 2, 3, 4] : [5, 6]) : [WEEKDAYS.findIndex(day => (short ?? long).startsWith(day))]
    return { days, from: match.index, to: match.index + match[0].length }
  })
  // "Monday–Friday", "Mon through Thu": each day between
  for (const [i, { days: [first], to }] of named.entries()) {
    const next = named[i + 1]
    if (next && /^\s*(-|–|—|through|thru|to)\s*$/.test(text.slice(to, next.from)))
      for (let day = first; day !== next.days[0]; day = (day + 1) % 7)
        named[i].days.push(day)
  }
  return [...new Set(named.flatMap(({ days }) => days))].sort()
}

/**
 * The dates a text names, none of them a day no month has, as "February 30". One written without its year is in the
 * year that puts it nearest a day, as a page names the coming term's dates, or left out where no day is given
 */
export const datesOf = (text: string, near?: Day) =>
  [...text.matchAll(DATE)].flatMap(([, monthNumber, dateNumbered, yearNumbered, name, dateNamed, yearNamed]): Day[] => {
    const month = name ? MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1 : +monthNumber
    const date = +(dateNamed ?? dateNumbered)
    const year = +(yearNamed ?? yearNumbered ?? 0)
    if (month < 1 || month > 12 || date < 1 || date > 31)
      return []
    const of = (y: number): Day =>
      [String(y).padStart(4, "0"), String(month).padStart(2, "0"), String(date).padStart(2, "0")].join("-")
    const nearest = (to: Day) =>
      [-1, 0, 1].map(i => of(+to.slice(0, 4) + i))
        .sort((a, b) => Math.abs(daysBetween(to, a)) - Math.abs(daysBetween(to, b)))[0]
    const day = year ? of(year < 100 ? 2000 + year : year) : near && nearest(near)
    return day && addDays(day, 0) === day ? [day] : []
  })

/** What a passage says of when, as of a day, or none where it states no time of day with a day, a date or an end */
export const whenOf = (text: string, today: Day): When | undefined => {
  const { times } = timesOf(text)
  const days = weekdaysOf(text)
  const dates = datesOf(text, today)
  if (!times.length || !(times.some(({ end }) => end) || days.length || dates.length))
    return
  return { days, times, dates, recurring: RECURRING.test(text) }
}

/** What a lead was read as, for someone to check: "Fri · 14:00–15:00 · 9/16, 9/30" */
export const whenText = ({ days, times, dates }: When) =>
  [
    days.map(day => WEEKDAYS[day]).join(", "),
    times.map(({ start, end }) => end ? `${start}–${end}` : start).join(", "),
    dates.join(", ")
  ].filter(Boolean).join(" · ")
