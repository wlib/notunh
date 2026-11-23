// Each calendar's answer read into events (event.mts): Presence (Wildcat Link) as its JSON, its clubs' weekly
// meetings among them, 25Live Publisher as its JSON, Athletics' Sidearm ICS, sport clubs' events as DSE Rec's JSON,
// and Campus Rec's programs as its Fusion pages. Pure, so scripts/map/events.mts fetches and the tests read fixtures.
// Entries of a shape not known here are left out rather than failing the night's build (usable in
// src/shared/json.mts), as is anything online, cancelled or postponed, staff training, a deadline, away games, and
// Manchester's. Places are matched by placeMatcher (aliases.mts) over the venue, then the description for
// calendar-only 25Live entries, whose venue is in prose. Times written in words, as a club's meeting time and an
// offering's title are, are read by when.mts

import * as v from "valibot"
import { type Event, type Org, type Result, SHORT, WEEK } from "./event.mts"
import { deduped } from "./sport.mts"
import { usable } from "../shared/json.mts"
import { MONTH, datesOf, timesOf, whenOf } from "./when.mts"
import { readEvents } from "../shared/ics.mts"
import { spanOn } from "../shared/recur.mts"
import { plainDay } from "../shared/temporal.mts"
import { DAY, type Day, HOUR, addDays, atClock, hhmm, localDay, weekday } from "../shared/time.mts"

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

/**
 * A series' first session, given its first start and the time of day its last end is written at, as some calendars
 * write one: that time on the start's day, or the next day's when that's no later, as a dance that ends at midnight does
 */
const firstSession = (start: number, clock: string) => {
  const sameDay = atClock(localDay(start), clock)
  return sameDay > start ? sameDay : atClock(addDays(localDay(start), 1), clock)
}

/** A local time with no offset, "2026-11-18T18:15:00" or "2026-10-26 17:15:00", as an instant on Durham's clock */
const localAt = (local: string) =>
  atClock(local.slice(0, 10), local.slice(11, 16))

/** Where the build keeps the events, as scripts/map/events.mts writes them */
export const EVENTS = "src/map/events.json"

/** Weeks the build lists, from today: asked of 25Live and DSE Rec, and told of clubs' meetings and curated series */
export const WEEKS = 3

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

/**
 * How long a Presence event may be and still be one stretch, like a two-day expo. Longer, it's a club's weekly meeting
 * written as its first session's start and its last's end, like 7 PM on 5 November to 8 PM on 12 November, which
 * would otherwise list it as on all week
 */
const SPAN = 2 * DAY

/** Presence's events, from the JSON its API answers, one longer than a span read as its first session */
export const fromPresence = (json: unknown, match: Matcher): Event[] =>
  v.parse(usable(PresenceEvent), json).flatMap(event => {
    if (event.isVirtualEventLink)
      return []
    const where = plain(event.location ?? "")
    const start = Date.parse(event.startDateTimeUtc)
    const end = Date.parse(event.endDateTimeUtc)
    return [{
      id:     `presence:${event.uri}`,
      title:  plain(event.eventName),
      start,
      end:    end - start > SPAN ? firstSession(start, hhmm(end)) : end,
      place:  match(where),
      where,
      source: "presence",
      url:    `https://unh.presence.io/event/${event.uri}`
    }]
  })

/** Wildcat Link's clubs, each with when and where it says it meets, as its own pages show them */
export const PRESENCE_CLUBS = "https://api.presence.io/unh/v1/organizations"

const PresenceClub = v.object({
  uri:                    v.string(),
  name:                   v.string(),
  regularMeetingTime:     v.nullish(v.string()),
  regularMeetingLocation: v.nullish(v.string()),
  categories:             v.nullish(v.array(v.string()))
})

/** Wildcat Link's clubs, every one, as browsing lists them: name, page, its meeting time and place as words, and its categories */
export const fromPresenceOrgs = (json: unknown): Org[] =>
  v.parse(usable(PresenceClub), json).flatMap(club => {
    const name = plain(club.name)
    const meets = plain(club.regularMeetingTime ?? "")
    const where = plain(club.regularMeetingLocation ?? "")
    return name ? [{ key: `presence:${club.uri}`, name, url: `https://unh.presence.io/organization/${club.uri}`, ...meets && { meets }, ...where && { where }, categories: club.categories ?? [] }] : []
  })

/** The longest a meeting is, longer being a place's hours */
const LONGEST = 4 * HOUR

/**
 * Meeting times that don't say a club meets every week, or that aren't a club's: "Bi-weekly", "Selected Thursdays",
 * "TBD", an office's hours
 */
const NOT_WEEKLY = /bi-?weekly|every other|alternat|select|certain|some |occasional|month|first|second|third|fourth|last|tb[ad]|var(y|ies)|office hours/i

/**
 * Wildcat Link's clubs' weekly meetings on some days, from the JSON its API answers for its clubs: one each day of a
 * weekday a club's meeting time names, where it names weekdays, one time and no date ("Tuesdays from 5:00-6:00 PM",
 * or "Mondays @ 7:30 PM", which has no end and so is told as starting then). Only the meeting fields are read, never
 * a club's description, which names its members
 */
export const fromPresenceClubs = (orgs: readonly Org[], days: readonly Day[], match: Matcher): Event[] =>
  orgs.flatMap(club => {
    const text = club.meets ?? ""
    const when = days.length ? whenOf(text, days[0]) : undefined
    if (!when?.days.length || when.times.length !== 1 || when.dates.length || NOT_WEEKLY.test(text))
      return []
    const [{ start, end = start }] = when.times
    // Every weekday, or longer than a meeting, is an office's hours: "Monday-Friday, 9AM-4PM"
    if (when.days.length >= 5 || atClock(days[0], end) - atClock(days[0], start) > LONGEST)
      return []
    const where = club.where ?? ""
    return days.filter(day => when.days.includes(weekday(day))).map(day => ({
      id:     `${club.key}/meeting/${day}`,
      title:  plain(`${club.name} meeting`),
      start:  atClock(day, start),
      end:    atClock(day, end),
      place:  match(where),
      where,
      source: "presence" as const,
      url:    club.url
    }))
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

/** A result, as Athletics writes it on the line under a game's title once it's final */
const SCORE = /^([WLT]) (\d+)-(\d+)(?: (.+))?$/
const PLACE = /^(\d+)(?:st|nd|rd|th) place\b/i

/** What went past the usual time, as a score says it: a shootout's "SO", else overtime's "OT" or "2OT", else nothing */
const extraOf = (text: string) => {
  if (/shootout/i.test(text))
    return "SO"
  const [, times] = text.match(/\b(\d?)(?:OT|overtime)\b/i) ?? []
  return times === undefined ? undefined : `${times}OT`
}

/**
 * A game's result as Athletics writes it, our score first: "W 3-1", "T 0-0", "W 2-1 Overtime" (said as "W 2-1 OT"),
 * "L 3-4 OT Shootout" or "T 4-4 (OT) - BU Wins Shootout, 3-2" (as "SO"); or a meet's "8th place, 177 points". A
 * meet's standing after one of its days ("2nd place, 116 points (Day 1)") isn't a result, nor is anything else
 */
export const resultOf = (line: string): Result | undefined => {
  const text = line.trim()
  const [, outcome, us, them, rest = ""] = text.match(SCORE) ?? []
  const extra = extraOf(rest)
  if (outcome)
    return { outcome: outcome as "W" | "L" | "T", us: Number(us), them: Number(them), ...extra && { extra } }
  const [, place] = text.match(PLACE) ?? []
  return place && !/\(Day \d+\)/i.test(text) ? { outcome: "placed", place: Number(place) } : undefined
}

/**
 * Athletics' games and meets, home and away, from Sidearm's ICS (src/shared/ics.mts), each with its game: the sport
 * and who against, read from its title ("Women's Ice Hockey vs Maine - Pink in the Rink"), whether it's in Durham,
 * and the result its description gives under the title once it's final. One in Durham is placed by its venue, which
 * the gazetteer knows, and one elsewhere nowhere, whatever its venue's called. Postponed ones are left out
 */
export const gamesOf = (ics: string, match: Matcher): Event[] =>
  readEvents(ics).flatMap(({ uid, title: summary, where, description, url, zone, day, session }) => {
    const id = uid.match(/^vcal_(\d+)-/)?.[1]
    if (!id || !summary || summary.startsWith("POSTPONED"))
      return []
    const named = plain(summary.replace(/^\[[A-Z]\] /, "").replace(/^University of New Hampshire /, "UNH "), Infinity)
    const [, sport, opponent] = named.match(/^(?:UNH )?(.+?) (?:vs\.?|at) (.+?)(?: - .*)?$/) ?? []
    const home = /^Durham, N\.H\.(,|$)/.test(where)
    const venue = where.match(/^Durham, N\.H\., (.+)$/)?.[1]
    const result = resultOf(description.split("\n")[1] ?? "")
    return [{
      id:     `athletics:${id}`,
      title:  named.slice(0, SHORT),
      ...spanOn(session, plainDay(day), zone),
      place:  venue && match(venue),
      where:  plain(venue ?? where),
      source: "athletics",
      url:    (url ?? "https://unhwildcats.com").replace(/&amp;/g, "&"),
      game:   { sport: plain(sport ?? named.replace(/^UNH /, "")), opponent: plain(opponent ?? ""), home, ...result && { result } }
    }]
  })

/** Athletics' home games, those in Durham, as lists of what's on campus have them */
export const fromAthletics = (ics: string, match: Matcher): Event[] =>
  gamesOf(ics, match).filter(event => event.game?.home)

/** The games events.json keeps, soonest first: those played, as far back as Athletics lists, and those in the week to come */
export const gamesKept = (games: readonly Event[], now: number): Event[] =>
  games.filter(game => game.start < now + WEEK * DAY).sort((a, b) => a.start - b.start)

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
  const from = localAt(start)
  const single = end.slice(0, 10) === start.slice(0, 10)
  // The end's time of day as written, not as an instant on its own day, which a series ending at 02:00 on the day
  // clocks spring forward would read as 03:00
  return { start: from, end: single ? localAt(end) : firstSession(from, end.slice(11, 16)), single }
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
 * Campus Rec's programs read as events: Outdoor Adventures' trips, the Mendums Pond shuttle, open skating, group
 * exercise classes, certification courses. Its index names its classifications, and each classification's page lists
 * its programs. A program is scheduled by calendar, in sessions, or by offerings each semester; both are read as
 * sessions, which recEvents makes events. Signing up takes UNH's sign-in, so each links to its program's page
 */
const FUSION = "https://crec.unh.edu/Program"

/** Campus Rec's index of programs, which names its classifications */
export const REC_INDEX = FUSION

/** Classifications that aren't for going to: staff training, birthday parties, passes, and DSE Rec's sport clubs */
const NOT_PROGRAMS = ["Staff Trainings", "Birthday Parties", "Outdoor Pool Passes", "Sport Clubs"]

/** The index's classifications, by id, those for going to */
export const classificationsOf = (html: string) =>
  [...html.matchAll(/classificationCheck" id="[^"]*" data-id="([0-9a-f-]{36})" data-name="([^"]*)"/g)]
    .filter(([, , name]) => !NOT_PROGRAMS.includes(plain(name)))
    .map(([, id]) => id)

/** A classification's page, which lists its programs */
export const classificationUrl = (classification: string) =>
  `${FUSION}?classificationId=${classification}`

/** The programs a classification's page lists, by id, each once */
export const programsOf = (html: string) =>
  [...new Set([...html.matchAll(/GetProgramDetails\?courseId=([0-9a-f-]{36})/g)].map(([, id]) => id))]

/** A program's page, which names its semesters and says what it is and where it meets */
export const programUrl = (program: string) =>
  `${FUSION}/GetProgramDetails?courseId=${program}`

/** A program's offerings in a semester, as its page asks for them */
export const offeringsUrl = (program: string, semester: string) =>
  `${FUSION}/GetOfferingsForSemester?semesterId=${semester}&programId=${program}`

/** A program's sessions on its calendar, as its page asks for them where it's scheduled by calendar */
export const instancesUrl = (program: string) =>
  `${FUSION}/GetProgramInstances?programID=${program}`

/**
 * A program, from its page: its name, its semesters by id and name ("Fall 2026"), its description, and whether it's
 * scheduled by calendar, as Open Skate is, rather than by offerings each semester
 */
export const programOf = (html: string) => {
  const name = plain(html.match(/<h1 class="progTitle">([^<]*)/)?.[1] ?? "")
  const select = html.match(/<select[^>]*name="semester-select"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? ""
  const semesters = [...select.matchAll(/<option value="([0-9a-f-]{36})">([^<]*)/g)].map(([, id, semester]) => ({ id, name: plain(semester) }))
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
  const description = plain(body.slice(body.indexOf("Waivers are required"), body.indexOf('id="schedule-heading"')), 2000)
  const [, scheduled, byCalendar] = html.match(/var ProgramScheduleTypeCV = '([^']*)'[\s\S]*?var ProgramScheduleTypeByCalendar = '([^']*)'/) ?? []
  return { name, semesters, description, byCalendar: scheduled !== undefined && scheduled === byCalendar }
}

/** A program as its sessions are read: its id, and its name and description as programOf reads them */
type Program = { id: string, name: string, description: string }

/**
 * One session of a program to sign up for, as both of Fusion's schedules come to: its own id, its title, its window,
 * its room as shown, the spots left, and when signing up closes
 */
type Session = { id: string, title: string, start: number, end: number, room?: string, left: number, closes?: number }

/**
 * Campus Rec's own names for its rooms, which name no building: its studios, kitchen and MAC courts are in the Hamel
 * Rec Center, its rink the Whittemore Center's
 */
const REC_ROOMS: [RegExp, string][] = [[/^Studio \d|Demonstration Kitchen|^MAC /, "Hamel Rec Center"], [/^Ice Rink$/, "Whittemore Center"]]

/**
 * A program's sessions as events, those with spots left, placed by their title or room, else where the program says
 * it meets ("Meeting location: Hamel Recreation Center", "held at Swasey Indoor Pool")
 */
const recEvents = (sessions: Session[], program: Program, match: Matcher): Event[] => {
  const meets = program.description.match(/(?:meet(?:ing location)?|held)\s*(?:at|:)\s*(?:the\s+)?([^.,]+)/i)?.[1] ?? ""
  return sessions.flatMap(({ id, title, start, end, room = "", left, closes }) => {
    if (left < 1)
      return []
    const building = REC_ROOMS.find(([pattern]) => pattern.test(room))?.[1] ?? ""
    const place = match(title) ?? match(room) ?? match(building) ?? match(meets)
    return [{
      id:     `rec:${id}`,
      title:  plain(title),
      start,
      end,
      place,
      where:  (room !== place ? room : "") || (place ? "" : plain(meets) || program.name),
      source: "rec",
      url:    programUrl(program.id),
      left,
      ...closes !== undefined && { closes }
    }]
  })
}

/** A meridiem or noon, as written */
const WRITTEN = /\d\s*[ap]\.?\s*m\b|\bnoon\b/i

/**
 * A window on a day from the time some text states (when.mts): its first range, "10am-4:30pm" or "6:00 - 8:00 PM",
 * else its one time alone, as a departure's is, "11:30am", an hour long
 */
const windowOf = (day: Day | undefined, text: string) => {
  const [time, ...others] = timesOf(text).times
  // A program's times are told as written, never guessed: "(10-4:30)" names no meridiem, so no time
  if (!day || !time || !time.end && others.length || !WRITTEN.test(text))
    return
  const start = atClock(day, time.start)
  return { start, end: time.end ? atClock(day, time.end) : start + HOUR }
}

/**
 * An offering's window, from its title as Campus Rec writes them, "Saturday 11/7 (10am-4:30pm): Pancakes on Mt. Major"
 * or "Saturday 9/5 11:30am Departure", in a semester's year, else from the first row of its schedule, with its room,
 * "Fri, Nov 20 2026" at "6:00 - 8:00 PM" in the Swasey Indoor Pool: a course over several days, or every Tuesday and
 * Thursday for four weeks, is read as its first session, as signing up for it is for all of it
 */
const scheduledOf = (title: string, year: string, card: string) => {
  const date = title.match(/\b\d{1,2}\/\d{1,2}\b/)
  // Its date written with the semester's year, "11/7/2026", is read as any date is
  if (date)
    return windowOf(datesOf(`${date[0]}/${year}`)[0], title.slice(date.index))
  const [, row] = card.match(/<tr class="regular-occurrence"[^>]*>([\s\S]*?)<\/tr>/) ?? []
  const cell = (name: string) => plain(row?.match(new RegExp(`<td class="?${name}"?>([^<]*)`))?.[1] ?? "")
  const [day] = datesOf(cell("schedule-until").match(/^\w{3}, \w{3} \d{1,2} \d{4}/)?.[0] ?? "")
  const window = windowOf(day, cell("time-column"))
  return window && { ...window, room: cell("location-column") }
}

/** The dates a title starts with where they're in words: "November 20th, 21st, 22nd" */
const DATES_FIRST = new RegExp(String.raw`^(?:${MONTH})\.? \d{1,2}(st|nd|rd|th)?(,\s*\d{1,2}(st|nd|rd|th)?)*\s+`)

/** What an offering is, its title without when it is or who leads it: "Pancakes on Mt. Major", else the program's name */
const whatOf = (title: string, program: string) => {
  const undated = title
    .replace(/^.*?\b\d{1,2}\/\d{1,2}(\s*-\s*\d{1,2}\/\d{1,2})?\b\s*(\([^)]*\))?\s*:?\s*/, "")
    .replace(DATES_FIRST, "")
  const what = timesOf(undated).rest
    // Its leaders, whom Campus Rec names, aren't what it is: "- Liv and Elise", "with Liv and Tessa"
    .replace(/\s+(-|with)\s+[A-Z][a-z]+(\s+(and|&)\s+[A-Z][a-z]+)*\s*$/, "")
    .trim()
  const named = !what || /^departure$/i.test(what) ? program : what.replace(/^\*[^*]*\*\s*/, "")
  // Who may go, where it's only some: "*HONORS STUDENTS ONLY*"
  return /honors students only/i.test(title) ? `Honors students: ${named}` : named
}

/** "until Wed, Nov 4 2026 at 12:00 AM", when signing up for an offering closes, on Durham's clock */
const closesOf = (card: string) => {
  const until = card.match(/until \w{3}, (\w{3} \d{1,2} \d{4} at \d{1,2}:\d\d [AP]M)/)?.[1] ?? ""
  const [day] = datesOf(until)
  const [time] = timesOf(until).times
  return day && time ? atClock(day, time.start) : undefined
}

/**
 * A program's offerings in a semester as events, from the cards its page loads: those not cancelled with a day and
 * time in their title or schedule (scheduledOf)
 */
export const fromRecOfferings = (html: string, program: Program, semester: string, match: Matcher): Event[] => {
  const year = semester.match(/\d{4}/)?.[0] ?? ""
  return recEvents(html.split(/(?=<div class="offering-card)/).slice(1).flatMap((card): Session[] => {
    const id = card.match(/data-offering-id="([0-9a-f-]{36})"/)?.[1]
    const title = plain(card.match(/<h3 class="card-title">([^<]*)/)?.[1] ?? "", 500)
    const when = scheduledOf(title, year, card)
    if (!id || !when || /^cancel/i.test(title))
      return []
    return [{
      ...when,
      id,
      title:  whatOf(title, program.name),
      left:   Number(card.match(/(\d+) Spots? available/i)?.[1] ?? 0),
      closes: closesOf(card)
    }]
  }), program, match)
}

const Appointment = v.object({
  ID:               v.pipe(v.string(), v.uuid()),
  StartDate:        v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)),
  EndDate:          v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)),
  Location:         v.nullish(v.string()),
  ProductName:      v.nullish(v.string()),
  NumberRegistered: v.number(),
  ClassSize:        v.number()
})

/**
 * A program's sessions on its calendar as events, as Open Skate and group exercise classes are scheduled, from the
 * appointments its page reads them from, on the local clock: one session each, the appointment's id shared by its
 * series, so each is told by its id and start
 */
export const fromRecInstances = (html: string, program: Program, match: Matcher): Event[] => {
  const json = plain(html.match(/id="ApptInfo"[^>]*value="([^"]*)"/)?.[1] ?? "[]", Infinity)
  return recEvents(v.parse(usable(Appointment), JSON.parse(json)).map(appointment => ({
    id:    `${appointment.ID}-${appointment.StartDate.slice(0, 16).replace(/\D/g, "")}`,
    title: appointment.ProductName ?? program.name,
    start: localAt(appointment.StartDate),
    end:   localAt(appointment.EndDate),
    room:  plain(appointment.Location ?? ""),
    left:  appointment.ClassSize - appointment.NumberRegistered
  })), program, match)
}

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
