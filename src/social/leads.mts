// Leads: passages on UNH's own pages that say when something happens, as "Russian Conversation Hour: 2-3pm every
// Friday in the Murkland G10 Lounge" does, which none of the calendars tell (sources.mts). scripts/leads.mts crawls
// the pages and writes what's left for someone to judge into curated.json (curated.mts). Each passage is a sentence
// or a list item of a page's <main> that states a time of day: a weekday or a date with a time, or a time range. Our
// own patterns read them, shaped to how UNH's pages write times ("3-4pm", "12:40-1:40", "noon", "Tuesdays"), and a
// guess of its days, times and place goes beside each. Then what isn't one is left out, cheapest first: by its page's
// address, by its wording, as a class meeting, and as what a calendar already tells. Pure

import * as v from "valibot"
import type { Section } from "../courses/course.mts"
import { type Event } from "./event.mts"
import { type Matcher, plain } from "./sources.mts"
import { type Day, Day as DaySchema, daysBetween, hhmm, localDay, weekday } from "../shared/time.mts"

/** A passage of a page, the heading it's under, and the page's address */
export type Passage = { text: string, heading: string, url: string }

/** Tags whose text isn't a page's own words */
const CHROME = /<(script|style|noscript|nav|header|footer|form|svg|button)\b[\s\S]*?<\/\1>/gi

/** Tags that end a block of text */
const BLOCK = /<\/?(?:p|li|tr|td|th|h[1-6]|div|section|article|dd|dt|br|ul|ol|table|blockquote)\b[^>]*>/gi

/** An address someone's mail goes to, which a lead never carries */
const MAIL = /[^\s<>()"@]+@[\w-]+(\.[\w-]+)+/g

/** A sentence's end: a stop and space before a capital, not after an initial or "a.m." */
const SENTENCE = /(?<=[a-z0-9)][.!?])\s+(?=[A-Z])/

/**
 * The passages of a page's <main>, or none where it has none: each block's sentences, under the last heading before
 * them, addresses dropped. A list item is one passage, however many sentences
 */
export const passagesOf = (html: string, url: string): Passage[] => {
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
  if (!main)
    return []
  const passages: Passage[] = []
  let heading = ""
  for (const part of main.replace(CHROME, " ").split(/(<(?:h[1-6]|li)\b[^>]*>[\s\S]*?<\/(?:h[1-6]|li)>)/i)) {
    const blocks = part.split(BLOCK).map(block => plain(block, 2000).replace(MAIL, "(address)")).filter(block => /\w{2}/.test(block))
    if (/^<h/i.test(part))
      heading = blocks.join(" ")
    else
      for (const block of blocks)
        for (const text of /^<li/i.test(part) ? [block] : block.split(SENTENCE))
          passages.push({ text, heading, url })
  }
  return passages
}

//#region Reading times

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

/** A weekday as written, "Tuesdays", "Thurs.", "Fri", capitalized, or "weekdays" and "weekends" */
const WEEKDAY = /\b(?:(Mon|Tue|Tues|Wed|Weds|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day)?s?\b\.?|(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b|(weekday|weekend)s\b)/g

/** A time of day: "3", "12:40", "4:30 p.m.", "10am", with its meridiem where written */
const TIME = String.raw`(\d{1,2})(?::([0-5]\d))?\s*([ap])?\.?\s*(?:m\b\.?)?`

/** A range of times, "3-4pm", "12:40-1:40", "9:00 AM to 5:00 PM", "noon-1pm" */
const RANGE = new RegExp(String.raw`(?<![\d/:])(?:${TIME}|(noon))\s*(?:-|–|—|to|until)\s*(?:${TIME}|(noon|midnight))`, "gi")

/** A time alone, which says it's a time: "at noon", "7pm", "7:30" */
const SINGLE = new RegExp(String.raw`(?<![\d/:])(?:(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\b\.?|(\d{1,2}):([0-5]\d)(?![\d/])|\b(noon|midnight)\b)`, "gi")

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** A date, "9/16", "10/28/2026", "November 20", "Nov. 4th" */
const DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g

/** Wording that says it's again and again */
const RECURRING = /\b(every|each|weekly|biweekly|monthly|alternating|every other|ongoing|all semester|throughout the semester)\b|\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)days\b/i

/** A time as "HH:MM", from its hours and minutes as written and a meridiem, where one's known */
const at = (hours: number, minutes: number, meridiem?: string) =>
  `${String(meridiem ? hours % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0) : hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`

/** A time with no meridiem read as a person would: 8 to 11 the morning, 12 noon, 1 to 7 the afternoon or evening */
const guessed = (hours: number) =>
  hours >= 8 && hours <= 11 ? "a" : "p"

export type Window = { start: string, end?: string }

/** What a passage says of when: its weekdays (0 Monday), its times, its dates, and whether it's again and again */
export type When = { days: number[], times: Window[], dates: Day[], recurring: boolean }

/** A date as written, in the year that puts it nearest a day, as a page names the coming term's dates without one */
const dateOf = (month: number, date: number, year: number | undefined, near: Day): Day | undefined => {
  if (month < 1 || month > 12 || date < 1 || date > 31)
    return
  const of = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}` as Day
  if (year)
    return of(year < 100 ? 2000 + year : year)
  const y = +near.slice(0, 4)
  return [y - 1, y, y + 1].map(of).sort((a, b) => Math.abs(daysBetween(near, a)) - Math.abs(daysBetween(near, b)))[0]
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
    const end = noon2 ? (noon2.toLowerCase() === "noon" ? "12:00" : "24:00") : undefined
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
      times.push({ start: word.toLowerCase() === "noon" ? "12:00" : "24:00" })
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
  const dates = [...text.matchAll(DATE)].flatMap(([, month, date, year, name, named, namedYear]) => {
    const day = name
      ? dateOf(MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1, +named, namedYear ? +namedYear : undefined, today)
      : dateOf(+month, +date, year ? +year : undefined, today)
    return day ? [day] : []
  })
  const ranged = times.some(({ end }) => end)
  if (!times.length || !(ranged || days.length || dates.length))
    return
  return { days, times, dates, recurring: RECURRING.test(text) }
}

//#endregion

//#region Leaving out

/** Pages that are never leads: people, the catalog, admissions, policies, forms, jobs, children's programs, exhibits */
const NOT_PAGES: [RegExp, string][] = [
  [/\/person\//, "a person's page"],
  [/catalog\.unh\.edu|\/(courses?|catalog|course-descriptions)(\/|$)/, "the course catalog"],
  [/\/(admissions?|admissions-aid|apply|tuition|financial-aid)(\/|$|-)/, "admissions"],
  [/[/-](polic(y|ies)|handbook|rules|governance|accreditation)(\/|$|-)/, "a policy"],
  [/\/(webform|form|login|user|search)(\/|$)/, "a form or sign-in"],
  [/\/(employment[\w-]*|jobs?|job-descriptions|student-employment)(\/|$)/, "a job"],
  [/\/(youth-programs|camps?)(\/|$)/, "children's programs"],
  [/\/exhibits?(\/|$)/, "an exhibit"]
]

/** Pages of news, which are dated and tell what was rather than what's on */
const NEWS = /\/(news|stories|story|blog|unh-today|press-releases?|newsroom)(\/|$)/

/** How old news may be and still be read, about a term */
const TERM_DAYS = 120

/** Why a page is left out by its address and when it was published, if it is */
export const pageExcluded = (url: string, published: Day | undefined, today: Day) =>
  NOT_PAGES.find(([pattern]) => pattern.test(new URL(url).pathname) || pattern.test(new URL(url).host))?.[1] ??
  (NEWS.test(new URL(url).pathname) && published && daysBetween(published, today) > TERM_DAYS ? "news over a term old" : undefined)

/** Wording of a class, a deadline, or hours a place is open, rather than something to go to */
const NOT_WORDING: [RegExp, string][] = [
  [/\b(credits?|credit hours?|prerequisites?|co-?requisites?|CRN|syllabus|syllabi|enroll(ed|ment)? in|section \d|lecture|lab section|recitation)\b/i, "a course"],
  [/\b(office hours|business hours|hours of operation|front desk|is open|are open|we are open|will be open|closed on|opens at|closes at|building hours|desk hours|drop off hours)\b|^(open|hours)\b/i, "hours a place is open"],
  [/\b(shifts?|work schedule|hours (a|per) week|student workers?)\b/i, "a job"],
  [/\b(park(ing)?|pay-to-park|pay & display)\b/i, "parking"]
]

/** Headings over hours a place is open, which every line under them is: "Fall semester building hours", "Contact us" */
const HOURS_HEADING = /\b(building|business|office|desk|operating|semester|library) hours\b|^hours\b|\bcontact\b/i

/** Deadlines, which name a time but no window: "due by 5pm", "apply by Friday at noon" */
const DEADLINE = /\b(deadline|due|no later than|submit|apply|applications?|register(ed)? by|registration (closes|ends)|nominations close|cancel(led|lations?)?\b.*\bby|by \d{1,2}(:\d\d)?\s*[ap]\.?m)\b/i

/**
 * Why a passage is left out by its wording, if it is: a course code of a subject the registrar has, like "RUSS 401",
 * a course's or an office's words, or a deadline with no range of times
 */
export const wordingExcluded = (text: string, when: When, subjects: ReadonlySet<string>) => {
  const code = [...text.matchAll(/\b([A-Z]{2,4})\s?(\d{3})[A-Z]?\b/g)].find(([, subject]) => subjects.has(subject))
  if (code)
    return `a course (${code[1]} ${code[2]})`
  return NOT_WORDING.find(([pattern]) => pattern.test(text))?.[1] ??
    (DEADLINE.test(text) && !when.times.some(({ end }) => end) ? "a deadline" : undefined)
}

/** The registrar's weekday letters, Monday first */
const LETTERS = "MTWRFSU"

/** "HH:MM" as minutes after midnight */
const minutes = (time: string) =>
  +time.slice(0, 2) * 60 + +time.slice(3)

/** How near two starts must be to be the same thing, in minutes */
const NEAR = 15

/**
 * The class a passage tells, if it does: a section meeting in the room it names ("Murkland 210") on one of its
 * weekdays, starting within a quarter hour of one of its times, while the section's dates run. Another room of the
 * building isn't the same, as a lounge down the hall from a class isn't
 */
export const classOf = (text: string, when: When, place: string | undefined, sections: readonly Section[], today: Day) => {
  if (!place || !when.days.length)
    return
  const starts = when.times.map(({ start }) => minutes(start))
  const words = new Set(text.split(/[^\w]+/))
  return sections.find(section => section.meetings.some(meeting =>
    meeting.place === place && meeting.to >= today && words.has(meeting.where.split(" ").at(-1)!) &&
    when.days.some(day => meeting.days.includes(LETTERS[day])) &&
    starts.some(start => Math.abs(start - meeting.start) <= NEAR)))
}

/**
 * The event a passage tells that a calendar already does, if one does: one at its place starting within a quarter
 * hour of one of its times, on one of its weekdays or dates
 */
export const listedAs = (when: When, place: string | undefined, events: readonly Event[]) => {
  if (!place)
    return
  const starts = when.times.map(({ start }) => minutes(start))
  return events.find(event => {
    const day = localDay(event.start)
    const start = minutes(hhmm(event.start))
    return event.place === place && starts.some(time => Math.abs(time - start) <= NEAR) &&
      (when.days.includes(weekday(day)) || when.dates.includes(day))
  })
}

//#endregion

//#region Scoring

/** Words of things to go to */
const EVENT_WORDS = /\b(hours?|tables?|drop-?ins?|open|socials?|workshops?|skat(e|ing)|conversation|coffee|tea|club|meet(s|ing|up)?|groups?|sessions?|nights?|games?|circles?|clinics?|classes|lessons?|jams?|screenings?|talks?|series|practice|café|cafe|lounge|trivia|karaoke|yoga|meditation|tutoring|labs?)\b/gi

/**
 * How likely a passage is to be something to go to: up for wording that it's again and again, for words of things
 * to go to, for a weekday, and for a place the map knows; down when every date it names is past, and when it names
 * neither a weekday nor a date
 */
export const scoreOf = (text: string, when: When, place: string | undefined, today: Day) => {
  const words = new Set([...text.matchAll(EVENT_WORDS)].map(([word]) => word.toLowerCase()))
  return (when.recurring ? 3 : 0) + Math.min(words.size, 3) * 2 + (when.days.length ? 1 : 0) + (place ? 2 : 0) +
    (when.dates.length && when.dates.every(day => day < today) ? -5 : 0) +
    (!when.days.length && !when.dates.length ? -2 : 0)
}

//#endregion

/** A lead: a passage, what it says of when and where, how likely it is to be something to go to */
export type Lead = Passage & { when: When, place?: string, score: number }

/** Why a passage isn't a lead, as its verdict is kept */
export type Left = Passage & { reason: string }

/** What leaves a passage out, beyond its page and wording: the classes meeting, and what the calendars already tell */
export type Known = { subjects: ReadonlySet<string>, sections: readonly Section[], events: readonly Event[] }

/** A page's passages as leads, or each with why it's left out, those stating no time of day neither */
export const leadsOf = (passages: readonly Passage[], match: Matcher, known: Known, today: Day) =>
  passages.flatMap((passage): (Lead | Left)[] => {
    const when = whenOf(passage.text, today)
    if (!when)
      return []
    const worded = wordingExcluded(passage.text, when, known.subjects) ?? (HOURS_HEADING.test(passage.heading) ? "hours a place is open" : undefined)
    if (worded)
      return [{ ...passage, reason: worded }]
    const place = match(passage.text) ?? match(passage.heading)
    const section = classOf(passage.text, when, place, known.sections, today)
    if (section)
      return [{ ...passage, reason: `a class meeting (${section.subject} ${section.number})` }]
    const event = listedAs(when, place, known.events)
    if (event)
      return [{ ...passage, reason: `listed already (${event.id})` }]
    const score = scoreOf(passage.text, when, place, today)
    return [score < 0 ? { ...passage, reason: "scored below zero" } : { ...passage, when, ...place && { place }, score }]
  })


/** What a lead was read as, for someone to check: "Fri · 14:00–15:00 · 9/16, 9/30" */
export const whenText = ({ days, times, dates }: When) =>
  [
    days.map(day => DAY_NAMES[day][0].toUpperCase() + DAY_NAMES[day].slice(1)).join(", "),
    times.map(({ start, end }) => end ? `${start}–${end}` : start).join(", "),
    dates.join(", ")
  ].filter(Boolean).join(" · ")

/**
 * What someone made of each passage judged, by its hash (scripts/leads.mts): accepted into curated.json, or rejected
 * and why, so it isn't asked again until its words change
 */
export const Seen = v.record(v.string(), v.object({
  verdict: v.picklist(["accepted", "rejected"]),
  reason:  v.optional(v.string()),
  url:     v.string(),
  judged:  DaySchema
}))
export type Seen = v.InferOutput<typeof Seen>

/** A robots.txt rule's path pattern, with its * and $, as a pattern */
const ruleOf = (path: string) =>
  new RegExp(`^${path.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`)

/**
 * Whether a robots.txt lets any crawler read a path: the rules of its groups for every user agent, the longest that
 * matches deciding, an Allow winning a tie
 */
export const robotsAllows = (robots: string, path: string) => {
  const rules: { allow: boolean, path: string }[] = []
  let agents: string[] = []
  let inRules = false
  for (const line of robots.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean)) {
    const [, field, value] = line.match(/^([\w-]+)\s*:\s*(.*)$/) ?? []
    if (!field)
      continue
    if (/^user-agent$/i.test(field)) {
      agents = inRules ? [value] : [...agents, value]
      inRules = false
    } else if (/^(allow|disallow)$/i.test(field)) {
      inRules = true
      if (agents.includes("*") && value)
        rules.push({ allow: /^allow$/i.test(field), path: value })
    }
  }
  const decides = rules.filter(rule => ruleOf(rule.path).test(path)).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))[0]
  return decides?.allow ?? true
}
