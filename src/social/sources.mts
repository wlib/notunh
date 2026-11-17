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
import { DAY, type Day, addDays, atClock, hhmm, localDay } from "../shared/time.mts"

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
 * A series' first session, given its first start and its last end, as some calendars write one: the end's time of day
 * on the start's day, or the next day's when that's no later, as a dance that ends at midnight does
 */
const firstSession = (start: number, end: number) => {
  const sameDay = atClock(localDay(start), hhmm(end))
  return sameDay > start ? sameDay : atClock(addDays(localDay(start), 1), hhmm(end))
}

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
      end:    end - start > SPAN ? firstSession(start, end) : end,
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
  const to = atClock(endDay, endClock.slice(0, 5))
  return endDay === startDay ? { start: from, end: to, single: true } : { start: from, end: firstSession(from, to), single: false }
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
 * exercise classes, certification courses. Its index lists programs by classification, each classification's page
 * listing its own; those of classifications that aren't for going to are left out. Signing up takes UNH's sign-in, so
 * each links to its program's page
 */
const FUSION = "https://crec.unh.edu/Program"

/** Campus Rec's index of programs, which names its classifications */
export const REC_INDEX = FUSION

/** Classifications that aren't things to go to: staff training, birthday parties, passes, and sport clubs, which DSE Rec tells */
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

/** A program's sessions on its calendar, as its page asks for them when it's scheduled by calendar rather than by offering */
export const instancesUrl = (program: string) =>
  `${FUSION}/GetProgramInstances?programID=${program}`

/**
 * A program's name, its semesters by id and name ("Fall 2026"), its description, and whether it's scheduled by
 * calendar, as Open Skate is, its sessions asked for by instancesUrl, rather than in offerings each semester, from its
 * page
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

type Program = Pick<ReturnType<typeof programOf>, "name" | "description"> & { id: string }

/** "10am", "11:30am", "4:30 pm" as "HH:MM" */
const clock24 = (hours: string, minutes = "00", meridiem: string) =>
  `${String(+hours % 12 + (/p/i.test(meridiem) ? 12 : 0)).padStart(2, "0")}:${minutes}`

/** A Durham day from its year, month and date as written */
const dayOf = (year: string, month: number | string, date: string) =>
  `${year}-${String(month).padStart(2, "0")}-${date.padStart(2, "0")}` as Day

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * A window on a day from the times written in some text: "10am-4:30pm", "6:00 - 8:00 PM", "9:00 AM - 8:00 PM", or a
 * departure alone, "11:30am", an hour long. A start with no meridiem has its end's, unless that puts it after the end
 */
const windowOf = (day: Day, text: string) => {
  const times = [...text.matchAll(/\b(\d{1,2})(?::(\d\d))?\s*(am|pm)?\b/gi)].filter(([, , minutes, meridiem]) => minutes || meridiem)
  const [first, second] = times
  if (!first || !(first[3] ?? second?.[3]))
    return
  const end = second && atClock(day, clock24(second[1], second[2], second[3] ?? first[3]))
  let start = atClock(day, clock24(first[1], first[2], first[3] ?? second[3]))
  if (end !== undefined && !first[3] && start >= end)
    start = atClock(day, clock24(first[1], first[2], "am"))
  const until = end ?? start + 3_600_000
  return until > start ? { start, end: until } : undefined
}

/**
 * An offering's day and times, from its title as Campus Rec writes them, "Saturday 11/7 (10am-4:30pm): Pancakes on
 * Mt. Major" or "Saturday 9/5 11:30am Departure", in a semester's year, else from the first row of its schedule,
 * "Fri, Nov 20 2026" at "6:00 - 8:00 PM" in the Swasey Indoor Pool: a course over several days, or every Tuesday and
 * Thursday for four weeks, is read as its first session, as signing up for it is for all of it
 */
const whenOf = (title: string, year: string, card: string) => {
  const date = title.match(/\b(\d{1,2})\/(\d{1,2})\b/)
  if (date)
    return windowOf(dayOf(year, date[1], date[2]), title.slice(date.index))
  const [, row] = card.match(/<tr class="regular-occurrence"[^>]*>([\s\S]*?)<\/tr>/) ?? []
  const cell = (name: string) => plain(row?.match(new RegExp(`<td class="?${name}"?>([^<]*)`))?.[1] ?? "")
  const [, month, day, rowYear] = cell("schedule-until").match(/^\w{3}, (\w{3}) (\d{1,2}) (\d{4})/) ?? []
  const index = MONTHS.indexOf(month)
  const window = index < 0 ? undefined : windowOf(dayOf(rowYear, index + 1, day), cell("time-column"))
  return window && { ...window, room: cell("location-column") }
}

/** What an offering is, its title without when it is or who leads it: "Pancakes on Mt. Major", else the program's name */
const whatOf = (title: string, program: string) => {
  const what = title
    .replace(/^.*?\b\d{1,2}\/\d{1,2}(\s*-\s*\d{1,2}\/\d{1,2})?\b\s*(\([^)]*\))?\s*:?\s*/, "")
    // Its dates where the title starts with them: "November 20th, 21st, 22nd"
    .replace(/^[A-Z][a-z]+ \d{1,2}(st|nd|rd|th)?(,\s*\d{1,2}(st|nd|rd|th)?)*\s+/, "")
    .replace(/\b\d{1,2}(:\d\d)?\s*(am|pm)?\s*-\s*\d{1,2}(:\d\d)?\s*(am|pm)\b\s*|\b\d{1,2}(:\d\d)?\s*(am|pm)\b\s*/gi, "")
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
  const index = MONTHS.indexOf(month)
  return index < 0 ? undefined : atClock(dayOf(year, index + 1, date), clock24(hours, minutes, meridiem))
}

/** Campus Rec's own names for its rooms, which name no building: its studios and kitchen are in the Hamel Rec Center, its rink the Whittemore Center's */
const REC_ROOMS: [RegExp, string][] = [[/^Studio \d|Demonstration Kitchen|^MAC /, "Hamel Rec Center"], [/^Ice Rink$/, "Whittemore Center"]]

/** One session of a program to sign up for, as both of Fusion's schedules come to: its own id, title, window, room, and spots left */
type Session = { id: string, title: string, start: number, end: number, room: string, left: number, closes?: number }

/**
 * A program's sessions as events, those with spots left, placed by their title or room, else where the program says
 * it meets ("Meeting location: Hamel Recreation Center", "held at Swasey Indoor Pool")
 */
const recEvents = (sessions: Session[], program: Program, match: Matcher): Event[] => {
  const meets = program.description.match(/(?:meet(?:ing location)?|held)\s*(?:at|:)\s*(?:the\s+)?([^.,]+)/i)?.[1] ?? ""
  return sessions.flatMap(({ id, title, start, end, room, left, closes }) => {
    if (left < 1)
      return []
    const place = match(title) ?? match(room) ?? match(REC_ROOMS.find(([pattern]) => pattern.test(room))?.[1] ?? "") ?? match(meets)
    return [{
      id:     `rec:${id}`,
      title:  plain(title),
      start,
      end,
      place,
      where:  plain(room !== place ? room : "") || (place ? "" : plain(meets) || program.name),
      source: "rec",
      url:    programUrl(program.id),
      left,
      ...closes !== undefined && { closes }
    }]
  })
}

/**
 * A program's offerings in a semester as events, from the cards its page loads: those not cancelled with a day and
 * time in their title or schedule (whenOf)
 */
export const fromRecOfferings = (html: string, program: Program, semester: string, match: Matcher): Event[] =>
  recEvents(html.split(/(?=<div class="offering-card)/).slice(1).flatMap(card => {
    const id = card.match(/data-offering-id="([0-9a-f-]{36})"/)?.[1]
    const title = plain(card.match(/<h3 class="card-title">([^<]*)/)?.[1] ?? "", 500)
    const when = whenOf(title, semester.match(/\d{4}/)?.[0] ?? "", card)
    if (!id || !when || /^cancel/i.test(title))
      return []
    const closes = closesOf(card)
    return [{ room: "", ...when, id, title: whatOf(title, program.name), left: Number(card.match(/(\d+) Spots? available/i)?.[1] ?? 0), ...closes !== undefined && { closes } }]
  }), program, match)

const Appointment = v.object({
  ID:               v.pipe(v.string(), v.uuid()),
  StartDate:        v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)),
  EndDate:          v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)),
  Location:         v.nullish(v.string()),
  ProductName:      v.nullish(v.string()),
  NumberRegistered: v.number(),
  ClassSize:        v.number()
})

/** A local "2026-11-18T18:15:00" as an instant */
const localAt = (local: string) =>
  atClock(local.slice(0, 10) as Day, local.slice(11, 16))

/**
 * A program's sessions on its calendar as events, as Open Skate and group exercise classes are scheduled, from the
 * appointments its page reads them from: one session each, the appointment's id shared by its series, so each is told
 * by its id and start
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
