// Leads: passages on UNH's own pages that say when something happens, as "Russian Conversation Hour: 2-3pm every Friday
// in the Murkland G10 Lounge" does, which none of the calendars tell (sources.mts). scripts/leads.mts crawls the pages
// and writes the leads for someone to judge into curated.json (curated.mts). A passage is a sentence or a list item of
// a page's <main>; one that states a time of day (when.mts) is a lead, with its days, times and place as read beside
// it, and its days proposed as a rule (the dates it names, "first Tuesday"), unless it's left out, cheapest first: by
// its page's address, by its wording, as a class meeting, or as what a calendar already tells. What someone made of
// each passage (Seen) and what robots.txt lets a crawler read are here too. Pure

import * as v from "valibot"
import { LETTERS } from "../courses/calendar.mts"
import type { Section } from "../courses/course.mts"
import type { Event } from "./event.mts"
import { type Matcher, plain } from "./sources.mts"
import { type When, proposedRule, whenOf } from "./when.mts"
import type { Rule } from "../shared/recur.mts"
import { type Day, Day as DaySchema, daysBetween, localDay, localMinutes, weekday } from "../shared/time.mts"

/** A passage of a page, the heading it's under, and the page's address */
export type Passage = { text: string, heading: string, url: string }

/** Tags whose text isn't a page's own words */
const CHROME = /<(script|style|noscript|nav|header|footer|form|svg|button)\b[\s\S]*?<\/\1>/gi

/** Tags that end a block of text */
const BLOCK = /<\/?(?:p|li|tr|td|th|h[1-6]|div|section|article|dd|dt|br|ul|ol|table|blockquote)\b[^>]*>/gi

/** An address someone's mail goes to, and a phone number, which a lead never carries */
const MAIL  = /[^\s<>()"@]+@[\w-]+(\.[\w-]+)+/g
const PHONE = /(\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.]\d{4}\b/g

/** A sentence's end: a stop and space before a capital, not after "a.m." or "p.m." */
const SENTENCE = /(?<=[a-z0-9)][.!?])(?<![ap]\.m\.)\s+(?=[A-Z])/

/** A page's <main>, which is all of it that's read, or none where it has none */
export const mainOf = (html: string) =>
  html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]

/**
 * The passages of a page's <main>: each block's sentences, under the last heading before them, addresses and phone
 * numbers dropped. A list item is one passage, however many sentences
 */
export const passagesOf = (html: string, url: string): Passage[] => {
  const passages: Passage[] = []
  let heading = ""
  for (const part of (mainOf(html) ?? "").replace(CHROME, " ").split(/(<(?:h[1-6]|li)\b[^>]*>[\s\S]*?<\/(?:h[1-6]|li)>)/i)) {
    const blocks = part.split(BLOCK)
      .map(block => plain(block, 2000).replace(MAIL, "(address)").replace(PHONE, "(phone)"))
      .filter(block => /\w{2}/.test(block))
    if (/^<h/i.test(part))
      heading = blocks.join(" ")
    else
      for (const block of blocks)
        for (const text of /^<li/i.test(part) ? [block] : block.split(SENTENCE))
          passages.push({ text, heading, url })
  }
  return passages
}

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

/** About a term in days: how old news may be and still be read, and how far ahead classes and series are known */
export const TERM_DAYS = 120

/** Why a page is left out by its address and when it was published, if it is */
export const pageExcluded = (url: string, published: Day | undefined, today: Day) => {
  const { host, pathname } = new URL(url)
  return NOT_PAGES.find(([pattern]) => pattern.test(host + pathname))?.[1] ??
    (NEWS.test(pathname) && published && daysBetween(published, today) > TERM_DAYS ? "news over a term old" : undefined)
}

/** Wording of a class, a deadline, or hours a place is open, rather than something to go to */
const NOT_WORDING: [RegExp, string][] = [
  [/\b(credits?|credit hours?|prerequisites?|co-?requisites?|CRN|syllabus|syllabi|enroll(ed|ment)? in|section \d|lab section|recitation)\b/i, "a course"],
  [/\b(office hours|business hours|hours of operation|front desk|is open|are open|we are open|will be open|closed on|opens at|closes at|building hours|desk hours|drop off hours)\b|^hours\b|^open:?\s+(?=\d|daily|every|week|mon|tue|wed|thu|fri|sat|sun)/i, "hours a place is open"],
  [/\b(shifts?|work schedule|hours (a|per) week|student workers?)\b/i, "a job"],
  [/\b(parking|park (in|at|on)|pay-to-park|pay & display)\b/i, "parking"]
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

/** How near two starts must be to be the same thing, in minutes */
const NEAR = 15

/** Whether one of a passage's times starts near a time of day, in minutes after midnight */
const startsNear = ({ times }: When, minutes: number) =>
  times.some(({ start }) => Math.abs(+start.slice(0, 2) * 60 + +start.slice(3) - minutes) <= NEAR)

/**
 * The class a passage tells, if it does: a section meeting in the room it names ("Murkland 210") on one of its
 * weekdays, starting within a quarter hour of one of its times, until the section's last day. Another room of the
 * building isn't the same, as a lounge down the hall from a class isn't
 */
export const classOf = (text: string, when: When, place: string | undefined, sections: readonly Section[], today: Day) => {
  if (!place)
    return
  const words = new Set(text.split(/\W+/))
  return sections.find(section => section.meetings.some(meeting =>
    meeting.place === place && meeting.to >= today && words.has(meeting.where.split(" ").at(-1)!) &&
    when.days.some(day => meeting.days.includes(LETTERS[day])) && startsNear(when, meeting.start)))
}

/**
 * The event a passage tells that a calendar already does, if one does: one at its place starting within a quarter
 * hour of one of its times, on one of its weekdays or dates
 */
export const listedAs = (when: When, place: string | undefined, events: readonly Event[]) => {
  if (!place)
    return
  return events.find(event => {
    const day = localDay(event.start)
    return event.place === place && startsNear(when, localMinutes(event.start)) &&
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

/** A lead: a passage, what it says of when and where, its days as a rule where one's read, how likely it is to be something to go to */
export type Lead = Passage & { when: When, rule?: Rule, place?: string, score: number }

/** A passage left out, and why */
type Left = Passage & { reason: string }

/** What leaves a passage out, beyond its page and wording: the classes meeting, and what the calendars already tell */
type Known = { subjects: ReadonlySet<string>, sections: readonly Section[], events: readonly Event[] }

/** A page's passages as leads, or each with why it's left out, those stating no time of day left out silently */
export const leadsOf = (passages: readonly Passage[], match: Matcher, known: Known, today: Day) =>
  passages.flatMap((passage): (Lead | Left)[] => {
    const when = whenOf(passage.text, today)
    if (!when)
      return []
    const worded = wordingExcluded(passage.text, when, known.subjects)
    if (worded || HOURS_HEADING.test(passage.heading))
      return [{ ...passage, reason: worded ?? "hours a place is open" }]
    const place = match(passage.text) ?? match(passage.heading)
    const section = classOf(passage.text, when, place, known.sections, today)
    if (section)
      return [{ ...passage, reason: `a class meeting (${section.subject} ${section.number})` }]
    const event = listedAs(when, place, known.events)
    if (event)
      return [{ ...passage, reason: `listed already (${event.id})` }]
    const score = scoreOf(passage.text, when, place, today)
    const rule = proposedRule(passage.text, when)
    return [score < 0 ? { ...passage, reason: "scored below zero" } : { ...passage, when, ...rule && { rule }, ...place && { place }, score }]
  })

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
  const [decides] = rules
    .filter(rule => ruleOf(rule.path).test(path))
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow))
  return decides?.allow ?? true
}
