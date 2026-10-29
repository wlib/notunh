// Each calendar's answer read into events (event.mts): Presence (Wildcat Link) as its JSON, 25Live Publisher as its
// JSON, Athletics' Sidearm ICS, and sport clubs' events as DSE Rec's JSON. Pure, so scripts/map/events.mts fetches
// and the tests read fixtures. Entries of a shape not known here are left out rather than failing the night's build
// (usable in src/shared/json.mts), as is anything online, cancelled or postponed, staff training, a deadline, away
// games, and Manchester's. Places are matched by placeMatcher (aliases.mts) over the venue, then the description for
// calendar-only 25Live entries, whose venue is in prose

import * as v from "valibot"
import { type Event, SHORT } from "./event.mts"
import { deduped } from "./sport.mts"
import { usable } from "../shared/json.mts"
import { type Day, addDays, atClock } from "../shared/time.mts"

/** Text as it's shown: tags and entities dropped, space squeezed, cut to a length */
export const plain = (html: string, max = SHORT) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|nbsp|amp|lt|gt|quot|#39);/gi, (entity, code: string) =>
      code === "nbsp" ? " " : code === "amp" ? "&" : code === "lt" ? "<" : code === "gt" ? ">" : code === "quot" ? "\"" : code === "#39" ? "'" :
      String.fromCodePoint(parseInt(code.slice(code[1] === "x" ? 2 : 1), code[1] === "x" ? 16 : 10)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)

export type Matcher = (text: string) => string | undefined

/** Where the build keeps the events, as scripts/map/events.mts writes them */
export const EVENTS = "src/map/events.json"

//#region Presence

const PresenceEvent = v.object({
  uri:                v.string(),
  eventName:          v.string(),
  location:           v.optional(v.string()),
  isVirtualEventLink: v.optional(v.boolean()),
  startDateTimeUtc:   v.pipe(v.string(), v.isoTimestamp()),
  endDateTimeUtc:     v.pipe(v.string(), v.isoTimestamp())
})

export const PRESENCE = "https://api.presence.io/unh/v1/events"

/** Presence's events, from the JSON its API answers */
export const fromPresence = (json: unknown, match: Matcher): Event[] =>
  v.parse(usable(PresenceEvent), json).flatMap(event => {
    if (event.isVirtualEventLink)
      return []
    const where = plain(event.location ?? "")
    return [{
      id:     `presence:${event.uri}`,
      title:  plain(event.eventName),
      start:  Date.parse(event.startDateTimeUtc),
      end:    Date.parse(event.endDateTimeUtc),
      place:  match(where),
      where,
      source: "presence",
      url:    `https://unh.presence.io/event/${event.uri}`
    }]
  })

//#endregion

//#region 25Live

/** A 25Live entry, which the academic calendar is read from too (src/courses/calendar.mts) */
export const Live25Event = v.object({
  eventID:          v.number(),
  title:            v.string(),
  description:      v.optional(v.string()),
  location:         v.optional(v.string()),
  startDateTime:    v.string(),
  endDateTime:      v.string(),
  startTimeZoneOffset: v.string(),
  endTimeZoneOffset:   v.string(),
  allDay:           v.optional(v.boolean()),
  canceled:         v.optional(v.boolean()),
  categoryCalendar: v.optional(v.string()),
  permaLinkUrl:     v.optional(v.string())
})

const LIVE25 = "https://25livepub.collegenet.com/calendars/university-of-new-hampshire-events.json"

/** 25Live's entries over some Durham days from one, as one request answers at most 200 */
export const live25Url = (day: Day, days: number) =>
  `${LIVE25}?startdate=${day.replaceAll("-", "")}&days=${days}`

/** Calendars whose entries aren't things to go to: staff training and deadlines */
const NOT_EVENTS = ["Training & Professional Development", "Academic Calendar"]

/** 25Live's times are local, like "2026-10-26T19:00:00", with their offset beside them, like "-0400" */
const at = (local: string, offset: string) =>
  Date.parse(`${local}${offset.replace(/^([+-]\d\d)(\d\d)$/, "$1:$2")}`)

/** 25Live's venues, where set, name rooms after buildings, like "Memorial Union Building 240 Strafford Room (MUB)" */
const venueOf = (location: string) =>
  /^(Calendar Only Event|Location Online)?$/.test(location.trim()) ? undefined : location.split(",")[0].trim()

/** 25Live's events, from one week's JSON */
export const from25Live = (json: unknown, match: Matcher): Event[] =>
  v.parse(usable(Live25Event), json).flatMap(event => {
    const venue = venueOf(event.location ?? "")
    const online = (event.location ?? "").trim() === "Location Online"
    if (event.canceled || event.allDay || online || NOT_EVENTS.some(calendar => event.categoryCalendar?.endsWith(calendar)) || venue?.startsWith("UNHM"))
      return []
    const description = plain(event.description ?? "", 2000)
    const where = venue ? plain(venue) : ""
    return [{
      id:     `25live:${event.eventID}`,
      title:  plain(event.title),
      start:  at(event.startDateTime, event.startTimeZoneOffset),
      end:    at(event.endDateTime, event.endTimeZoneOffset),
      place:  match(where) ?? match(description),
      where,
      source: "25live",
      url:    event.permaLinkUrl ?? "https://www.unh.edu/calendar"
    }]
  })

//#endregion

//#region Athletics

export const ATHLETICS = "https://unhwildcats.com/calendar.ashx/calendar.ics"

/** An ICS's events, each as its properties, lines unfolded and values unescaped */
const vevents = (ics: string) =>
  ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).reduce<Record<string, string>[]>((events, line) => {
    const [, name, value] = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/) ?? []
    if (name === "BEGIN" && value === "VEVENT")
      events.push({})
    else if (name && events.length && !("END" in events.at(-1)!))
      events.at(-1)![name === "END" ? "END" : name] = value.replace(/\\([,;\\])/g, "$1").replace(/\\n/g, "\n")
    return events
  }, [])

/** A UTC ICS time, like 20260925T190000Z */
const utc = (value: string) => {
  const [, y, mo, d, h, mi, s] = value.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/) ?? []
  return y ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : NaN
}

/** Athletics' home games, from Sidearm's ICS: those in Durham, by their venue, which the gazetteer knows */
export const fromAthletics = (ics: string, match: Matcher): Event[] =>
  vevents(ics).flatMap(event => {
    const [, venue] = event.LOCATION?.match(/^Durham, N\.H\., (.+)$/) ?? []
    const start = utc(event.DTSTART ?? "")
    const end = utc(event.DTEND ?? "")
    const id = event.UID?.match(/^vcal_(\d+)-/)?.[1]
    if (!venue || !id || Number.isNaN(start) || Number.isNaN(end) || !event.SUMMARY || event.SUMMARY.startsWith("POSTPONED"))
      return []
    const title = plain(event.SUMMARY.replace(/^\[[WLT]\] /, "").replace(/^University of New Hampshire /, "UNH "))
    return [{ id: `athletics:${id}`, title, start, end, place: match(venue), where: plain(venue), source: "athletics", url: (event.URL ?? "https://unhwildcats.com").replace(/&amp;/g, "&") }]
  })

//#endregion

//#region DSE Rec

const DserecEvent = v.object({
  id:                     v.number(),
  name:                   v.string(),
  club_id:                v.number(),
  club_name:              v.string(),
  type:                   v.string(),
  field:                  v.nullish(v.string()),
  location:               v.string(),
  calculated_start:       v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\d \d\d:\d\d/)),
  calculated_end:         v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\d \d\d:\d\d/)),
  calculated_status:      v.optional(v.string()),
  home_events_off_campus: v.optional(v.union([v.number(), v.boolean()]))
})

/** Sport clubs' events, every club's, as DSE Rec's own pages ask for them */
const DSEREC = "https://unh.dserec.com/api/clubsports/online/events/list"

/** DSE Rec's events overlapping some Durham days, both included, in one page */
export const dserecUrl = (from: Day, to: Day) => {
  const us = (day: Day) => day.replace(/^(\d{4})-(\d\d)-(\d\d)$/, "$2/$3/$1")
  return `${DSEREC}?limit=999999&page=1&${new URLSearchParams({ "order[0]": "calculated_start:asc", "filter[0]": `date:${us(from)},${us(to)}` })}`
}

/** DSE Rec's word for on campus, as against "away" */
const HOME = "collage"

/** Statuses of an event that isn't happening; nearly all are pending, which are shown */
const OFF = /cancel|disapprov|declin|reject|denied/

/**
 * The window of one session. A repeating practice is written with its first session's start and the series' last
 * day as its end, like 17:15 on 5 October to 19:15 on 21 December, so an end on a later day than the start is read as
 * that time of day after the start: the same day, or the next when it's earlier on the clock, as a dance that ends at
 * midnight does. A tournament over a weekend is read as its first day by the same rule
 */
const sessionOf = (start: string, end: string) => {
  const [startDay, startClock] = start.split(" ")
  const [endDay, endClock] = end.split(" ")
  const from = atClock(startDay, startClock.slice(0, 5))
  if (endDay === startDay)
    return { start: from, end: atClock(endDay, endClock.slice(0, 5)), single: true }
  const sameDay = atClock(startDay, endClock.slice(0, 5))
  return { start: from, end: sameDay > from ? sameDay : atClock(addDays(startDay, 1), endClock.slice(0, 5)), single: false }
}

/**
 * The club, then the event's name, with its type between where the name doesn't say it: "Tennis: Practice", "Men's
 * Soccer game: Maine", "Tennis: Pickleball Tournament". A plain "event" isn't said
 */
const titleOf = ({ club_name, name, type }: Pick<v.InferOutput<typeof DserecEvent>, "club_name" | "name" | "type">) =>
  plain(type === "event" || name.toLowerCase().includes(type.toLowerCase()) ? `${club_name}: ${name}` : `${club_name} ${type}: ${name}`)

/**
 * Sport clubs' home events, from DSE Rec's JSON: practices, games, tournaments, and the rest, on campus and not
 * cancelled. A practice is often listed twice, as its one session and as a series starting that day, which read as
 * the same window; the club's one event a window is kept, the single session's id where there is one
 */
export const fromDserec = (json: unknown, match: Matcher): Event[] => {
  const kept = new Map<string, { event: Event, single: boolean }>()
  for (const event of v.parse(v.object({ data: usable(DserecEvent) }), json).data) {
    if (event.location !== HOME || event.home_events_off_campus || OFF.test(event.calculated_status ?? ""))
      continue
    const { start, end, single } = sessionOf(event.calculated_start, event.calculated_end)
    const where = plain(event.field ?? "")
    const key = `${event.club_id} ${start} ${end}`
    if (kept.has(key) && (kept.get(key)!.single || !single))
      continue
    kept.set(key, { single, event: {
      id:     `dserec:${event.id}`,
      title:  titleOf(event),
      start,
      end,
      place:  match(where),
      where,
      source: "dserec",
      url:    `https://unh.dserec.com/online/clubsports/club/${event.club_id}/events`
    } })
  }
  return [...kept.values()].map(({ event }) => event)
}

//#endregion

//#region Campus Rec programs

/**
 * Campus Rec's programs read as events: Outdoor Adventures' trips, the Mendums Pond shuttle, pool kayaking, night
 * skiing. Signing up takes UNH's sign-in, so each links to its program's page
 */
export const REC_PROGRAMS = ["392bd3c0-01a0-44f3-b54e-5da34cd69d70", "9448c2c6-6b22-44dd-a691-5a7f516751f1", "6cfccb96-0c98-4d72-b77e-95f61928d923", "8520b0bd-ad58-415b-a070-7dc7c18e06fc"]

const FUSION = "https://crec.unh.edu/Program"

/** A program's page, which names its semesters and says what it is and where it meets */
export const programUrl = (program: string) =>
  `${FUSION}/GetProgramDetails?courseId=${program}`

/** A program's offerings in a semester, as its page asks for them */
export const offeringsUrl = (program: string, semester: string) =>
  `${FUSION}/GetOfferingsForSemester?semesterId=${semester}&programId=${program}`

/** A program's name, its semesters by id and name ("Fall 2026"), and its description, from its page */
export const programOf = (html: string) => {
  const name = plain(html.match(/<h1 class="progTitle">([^<]*)/)?.[1] ?? "")
  const select = html.match(/<select[^>]*name="semester-select"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? ""
  const semesters = [...select.matchAll(/<option value="([0-9a-f-]{36})">([^<]*)/g)].map(([, id, semester]) => ({ id, name: plain(semester) }))
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
  const description = plain(body.slice(body.indexOf("Waivers are required"), body.indexOf('id="schedule-heading"')), 2000)
  return { name, semesters, description }
}

/** "10am", "11:30am", "4:30 pm" as "HH:MM" */
const clock24 = (hours: string, minutes = "00", meridiem: string) =>
  `${String(+hours % 12 + (/p/i.test(meridiem) ? 12 : 0)).padStart(2, "0")}:${minutes}`

/**
 * An offering's day and times from its title, as Campus Rec writes them, "Saturday 11/7 (10am-4:30pm): Pancakes on
 * Mt. Major" or "Saturday 9/5 11:30am Departure", in a semester's year; a departure alone is an hour long
 */
const whenOf = (title: string, year: string) => {
  const date = title.match(/\b(\d{1,2})\/(\d{1,2})\b/)
  const times = [...title.matchAll(/\b(\d{1,2})(?::(\d\d))?\s*(am|pm)\b/gi)]
  if (!date || !times.length)
    return
  const day = `${year}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}` as Day
  const start = atClock(day, clock24(times[0][1], times[0][2], times[0][3]))
  const end = times[1] ? atClock(day, clock24(times[1][1], times[1][2], times[1][3])) : start + 3_600_000
  return end > start ? { start, end } : undefined
}

/** What an offering is, its title without when it is or who leads it: "Pancakes on Mt. Major", else the program's name */
const whatOf = (title: string, program: string) => {
  const what = title
    .replace(/^.*?\b\d{1,2}\/\d{1,2}\b\s*(\([^)]*\))?\s*:?\s*/, "")
    .replace(/\b\d{1,2}(:\d\d)?\s*(am|pm)\b\s*/gi, "")
    // Its leaders, whom Campus Rec names, aren't what it is: "- Liv and Elise", "with Liv and Tessa"
    .replace(/\s+(-|with)\s+[A-Z][a-z]+(\s+(and|&)\s+[A-Z][a-z]+)*\s*$/, "")
    .trim()
  const named = !what || /^departure$/i.test(what) ? program : what.replace(/^\*[^*]*\*\s*/, "")
  // Who may go, where it's only some: "*HONORS STUDENTS ONLY*"
  return /honors students only/i.test(title) ? `Honors students: ${named}` : named
}

/** "until Wed, Nov 4 2026 at 12:00 AM", when signing up for an offering closes, on Durham's clock */
const closesOf = (card: string) => {
  const [, month, date, year, hours, minutes, meridiem] = card.match(/until \w{3}, (\w{3}) (\d{1,2}) (\d{4}) at (\d{1,2}):(\d\d) ([AP]M)/) ?? []
  const index = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month)
  return index < 0 ? undefined : atClock(`${year}-${String(index + 1).padStart(2, "0")}-${date.padStart(2, "0")}` as Day, clock24(hours, minutes, meridiem))
}

/**
 * A program's offerings in a semester as events, from the cards its page loads: those with a day and time in their
 * title and spots left, placed by their title, else where the program says it meets ("Meeting location: Hamel
 * Recreation Center", "held at Swasey Indoor Pool")
 */
export const fromRecOfferings = (html: string, program: { id: string, name: string, description: string }, semester: string, match: Matcher): Event[] =>
  html.split(/(?=<div class="offering-card)/).slice(1).flatMap(card => {
    const id = card.match(/data-offering-id="([0-9a-f-]{36})"/)?.[1]
    const title = plain(card.match(/<h3 class="card-title">([^<]*)/)?.[1] ?? "", 500)
    const left = Number(card.match(/(\d+) Spots? available/i)?.[1] ?? 0)
    const when = whenOf(title, semester.match(/\d{4}/)?.[0] ?? "")
    if (!id || !when || left < 1)
      return []
    const meets = program.description.match(/(?:meet(?:ing location)?|held)\s*(?:at|:)\s*(?:the\s+)?([^.,]+)/i)?.[1] ?? ""
    const place = match(title) ?? match(meets)
    const closes = closesOf(card)
    return [{
      id:     `rec:${id}`,
      title:  plain(whatOf(title, program.name)),
      ...when,
      place,
      where:  place ? "" : plain(meets) || program.name,
      source: "rec",
      url:    programUrl(program.id),
      left,
      ...closes !== undefined && { closes }
    }]
  })

//#endregion

/**
 * Every source's events as one list, those ending before `from` left out, soonest first, each id once, and each thing
 * more than one calendar tells told once (deduped in sport.mts)
 */
export const merged = (lists: readonly Event[][], from: number): Event[] => {
  const byId = new Map<string, Event>()
  for (const event of lists.flat())
    if (event.end >= from && event.start <= event.end && !byId.has(event.id))
      byId.set(event.id, event)
  return deduped([...byId.values()])
}
