// iCalendar (RFC 5545), read and written: the one reader, for Athletics' calendar (src/social/sources.mts), Campus
// Rec's recurrence rules (src/courses/rec.mts) and a calendar someone imports (src/courses/imported.mts), and the one
// writer, for an event, a series, a section and a person's feed (src/courses/ics.mts). Both go through rules
// (recur.mts): a VEVENT read is a session, and a session written is as few VEVENTs as say it
//
// Reading. Only what's at a time of day: a VEVENT on whole days is left out. An RRULE becomes a rule where the rules
// can say it: DAILY, WEEKLY and MONTHLY, with INTERVAL, BYDAY (ordinals too), BYMONTHDAY, BYSETPOS over one weekday,
// WKST, UNTIL and COUNT, the count found by counting once. One they can't (YEARLY, BYMONTH, BYWEEKNO, BYYEARDAY,
// times within a day, BYSETPOS over several days) is read as its first day alone. A rule's days start at DTSTART,
// which counts only where the rule falls on it, as Apple's calendar and DevExtreme read it. EXDATEs are excepted and
// RDATEs added, by their days; an instance moved (RECURRENCE-ID) is excepted from its series and read as an event of
// its own. Days and times are in the event's own zone: its TZID where that's a zone this engine knows or one of
// Windows' names for one, UTC for a time ending in Z, else Durham's, as a floating time means wherever it's read
//
// Writing. Only a rule with a first and a last day, as everything written here has. A rule's skeletons are the parts
// of it one RRULE can say: weekly days, every nth week of them, and an nth weekday or day of the month, within what
// between bounds them to, found through any, except and between. Each is a VEVENT whose DTSTART is its first day
// the rule really falls on, with an EXDATE for each of its days the rule doesn't (except's, or a day an earlier
// skeleton already tells), found by asking the rule itself over its days. A day no skeleton tells is a VEVENT of its
// own, never an RDATE, which Outlook doesn't read. So what's written always says the rule's days, however it's
// composed. Times are Durham's under a VTIMEZONE, as Apple's and Google's calendars take them, UNTIL is UTC as
// DTSTART then requires (3.3.10), and lines fold at 75 octets. Pure

import { type Rule, type Session, type Weekday, WEEKDAYS, any, between, boundsOf, daily, every, except, nth, occurrences, occurs, on, weekly } from "./recur.mts"
import { Temporal, instantAt, plainDay } from "./temporal.mts"
import { type Day, TIME_ZONE } from "./time.mts"

/** RFC 5545's weekdays, Monday first, as WEEKDAYS are */
const CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

//#region Reading

/** A property of a component: its value as written, and the zone its parameters name */
type Property = { value: string, tzid?: string }

/** A component's properties by name, each as often as it's given, as EXDATE may be */
type Component = Record<string, Property[]>

/** A content line: its name, its parameters, whose quoted values may hold a colon, and its value */
const LINE_SHAPE = /^([\w.-]+)((?:;[\w-]+=(?:"[^"]*"|[^;:"])*)*):(.*)$/s

/** A file's VEVENTs, lines unfolded, what's within them (an alarm) left out */
const veventsOf = (text: string): Component[] => {
  const events: Component[] = []
  let event: Component | undefined
  let depth = 0
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const [, name, params, value] = line.match(LINE_SHAPE) ?? []
    if (!name)
      continue
    const key = name.toUpperCase()
    if (key === "BEGIN") {
      if (event)
        depth++
      else if (value.toUpperCase() === "VEVENT")
        events.push(event = {})
    }
    else if (key === "END") {
      if (depth)
        depth--
      else if (value.toUpperCase() === "VEVENT")
        event = undefined
    }
    else if (event && !depth)
      (event[key] ??= []).push({ value, tzid: params.match(/;TZID="?([^";:]+)/i)?.[1] })
  }
  return events
}

/** A text value as it reads, its escapes undone */
const textOf = (property: Property | undefined) =>
  (property?.value ?? "").replace(/\\([\\;,nN])/g, (_, char: string) => char.toLowerCase() === "n" ? "\n" : char)

/** Windows' names for the zones Outlook writes around here, as it names them in place of the zone itself */
const WINDOWS: Record<string, string> = {
  "Eastern Standard Time":     "America/New_York",
  "Central Standard Time":     "America/Chicago",
  "Mountain Standard Time":    "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time":     "America/Los_Angeles",
  "Alaskan Standard Time":     "America/Anchorage",
  "Hawaiian Standard Time":    "Pacific/Honolulu",
  "Atlantic Standard Time":    "America/Halifax",
  "GMT Standard Time":         "Europe/London"
}

/** Each TZID met, as the zone it means, asked of the engine once */
const zones = new Map<string, string | undefined>()

/** The zone a TZID means, if this engine knows it: itself, or the one Windows names by it */
const zoneOf = (tzid: string) => {
  if (!zones.has(tzid))
    zones.set(tzid, [tzid, WINDOWS[tzid]].find(zone => {
      try {
        return zone !== undefined && Boolean(new Intl.DateTimeFormat("en-US", { timeZone: zone }))
      }
      catch {
        return false
      }
    }))
  return zones.get(tzid)
}

/** A date or a date-time as a property gives it: its day, its time of day unless it's a date alone, and its zone */
type Stamp = { date: Temporal.PlainDate, time?: Temporal.PlainTime, zone: string }

const stampOf = (value: string, tzid: string | undefined, floating: string): Stamp | undefined => {
  const [, year, month, date, hours, minutes, seconds, z] = value.trim().match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/) ?? []
  try {
    return year === undefined ? undefined : {
      date: new Temporal.PlainDate(+year, +month, +date),
      time: hours === undefined ? undefined : new Temporal.PlainTime(+hours, +minutes, +(seconds ?? 0)),
      zone: z ? "UTC" : tzid && zoneOf(tzid) || floating
    }
  }
  catch {
    // A day no month has, or an hour no day has
  }
}

/** Every date or date-time a property lists, as RDATE and EXDATE list several */
const stampsOf = (properties: Property[] | undefined, floating: string) =>
  (properties ?? []).flatMap(({ value, tzid }) => value.split(",").flatMap(one => stampOf(one, tzid, floating) ?? []))

/** A stamp's day and time of day by another zone's clock; a date alone is its day wherever it's read */
const wallIn = ({ date, time, zone }: Stamp, other: string) =>
  time && zone !== other ? date.toZonedDateTime({ timeZone: zone, plainTime: time }).withTimeZone(other).toPlainDateTime() : date.toPlainDateTime(time)

const clockOf = (time: Temporal.PlainTime) =>
  time.toString({ smallestUnit: "minute" })

/** A DURATION, "PT1H30M", or none where it isn't one */
const durationOf = (property: Property | undefined) => {
  try {
    return property && Temporal.Duration.from(property.value.trim())
  }
  catch {
    // Not a length of time
  }
}

/** How far a rule with a COUNT is followed from its first day, as its days are counted one by one */
const COUNTED_DAYS = 20 * 366

/** The parts of an RRULE no rule says */
const UNSAID = ["BYMONTH", "BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]

/** One rule alone, or any of several */
const anyOf = (rules: Rule[]) =>
  rules.length === 1 ? rules[0] : any(...rules)

/** A monthly rule's days within each month: its BYDAY, by ordinals or one weekday's BYSETPOS, its BYMONTHDAY, else its first day's date */
const monthlyOf = (parts: Record<string, string>, first: Temporal.PlainDate): Rule | undefined => {
  if (!parts.BYDAY) {
    const dates = (parts.BYMONTHDAY ?? String(first.day)).split(",").map(Number)
    return !("BYSETPOS" in parts) && dates.every(date => Number.isInteger(date) && date !== 0 && Math.abs(date) <= 31) ? anyOf(dates.map(date => nth(date))) : undefined
  }
  const days = parts.BYDAY.split(",").map(day => day.match(/^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/))
  if ("BYMONTHDAY" in parts || days.some(day => !day))
    return
  const named = days.map(day => ({ ordinal: +(day![1] ?? 0), weekday: WEEKDAYS[CODES.indexOf(day![2])] }))
  if ("BYSETPOS" in parts)
    return named.length === 1 && !named[0].ordinal && /^[+-]?[1-5]$/.test(parts.BYSETPOS) ? nth(+parts.BYSETPOS, named[0].weekday) : undefined
  if (named.every(({ ordinal }) => ordinal))
    return anyOf(named.map(({ ordinal, weekday }) => nth(ordinal, weekday)))
  return named.some(({ ordinal }) => ordinal) ? undefined : weekly(...named.map(({ weekday }) => weekday))
}

/** An RRULE's days with no first or last, where the rules can say them */
const repeating = (parts: Record<string, string>, first: Temporal.PlainDate): Rule | undefined => {
  const interval = +(parts.INTERVAL ?? 1)
  if (!Number.isInteger(interval) || interval < 1 || UNSAID.some(part => part in parts))
    return
  const from = first.toString()
  if (parts.FREQ === "MONTHLY") {
    const base = monthlyOf(parts, first)
    return base && (interval === 1 ? base : every(interval, base, from, "month"))
  }
  const days = parts.BYDAY?.split(",").map(day => WEEKDAYS[CODES.indexOf(day)])
  if ("BYMONTHDAY" in parts || "BYSETPOS" in parts || days?.some(day => !day))
    return
  if (parts.FREQ === "DAILY") {
    const base = days ? weekly(...days) : daily
    return interval === 1 ? base : every(interval, base, from, "day")
  }
  if (parts.FREQ !== "WEEKLY")
    return
  const named = days ?? [WEEKDAYS[first.dayOfWeek - 1]]
  const weekStart = CODES.indexOf(parts.WKST ?? "MO")
  if (interval === 1 || weekStart <= 0)
    return interval === 1 ? weekly(...named) : every(interval, weekly(...named), from)
  // Weeks counted from another day than Monday, as Fusion's are: each weekday's own cycle, from its day in the first such week
  const start = first.subtract({ days: (first.dayOfWeek - 1 - weekStart + 7) % 7 })
  return anyOf(named.map(day => every(interval, weekly(day), start.add({ days: (WEEKDAYS.indexOf(day) - weekStart + 7) % 7 }).toString())))
}

/**
 * An RRULE as a rule, of something first on a day at a time of day by a zone's clock: its days from that first day,
 * to its UNTIL or its COUNT's last. None where the rules can't say it
 */
export const ruleOfRRule = (rrule: string, first: Temporal.PlainDate, time: Temporal.PlainTime | undefined, zone: string): Rule | undefined => {
  const parts = Object.fromEntries(rrule.toUpperCase().split(";").filter(Boolean).map(part => part.trim().split("=") as [string, string]))
  const rule = repeating(parts, first)
  if (!rule)
    return
  const from = first.toString()
  if (parts.UNTIL) {
    const until = stampOf(parts.UNTIL, undefined, zone)
    if (!until)
      return
    // The last day is UNTIL's by the zone's clock, unless that day's occurrence would start after it
    const last = wallIn(until, zone)
    const isBefore = until.time && time && Temporal.PlainTime.compare(last.toPlainTime(), time) < 0
    return between(from, last.toPlainDate().subtract({ days: isBefore ? 1 : 0 }).toString(), rule)
  }
  if (parts.COUNT) {
    const count = +parts.COUNT
    if (!Number.isInteger(count) || count < 1)
      return
    let made = 0
    for (let i = 0, day = first; i < COUNTED_DAYS; i++, day = day.add({ days: 1 }))
      if (occurs(rule, day) && ++made === count)
        return between(from, day.toString(), rule)
  }
  return between(from, undefined, rule)
}

/** A VEVENT as read: what it is, and when, as a session by its own zone's clock */
export type Read = {
  uid:         string,
  title:       string,
  where:       string,
  /** What it says of itself, as written, line breaks kept */
  description: string,
  url?:        string,
  /** The zone its days and times of day are in */
  zone:        string,
  /** Its first day there, which a VEVENT with no rule is on alone */
  day:         Day,
  session:     Session
}

/**
 * A calendar's events at a time of day: each such VEVENT, but those cancelled, as a session, in the order written.
 * A time with no zone is on a clock of the reader's choosing, Durham's unless said
 */
export const readEvents = (text: string, floating = TIME_ZONE): Read[] => {
  const events = veventsOf(text)
  /** The days moved or cancelled instances would have been on, by their series' UID */
  const moved = new Map<string, Stamp[]>()
  for (const event of events) {
    const [was] = stampsOf(event["RECURRENCE-ID"], floating)
    if (was)
      moved.set(textOf(event.UID?.[0]), [...moved.get(textOf(event.UID?.[0])) ?? [], was])
  }
  return events.flatMap((event): Read[] => {
    const uid = textOf(event.UID?.[0])
    const [start] = stampsOf(event.DTSTART, floating)
    if (!start?.time || textOf(event.STATUS?.[0]).toUpperCase() === "CANCELLED")
      return []
    const { date, time, zone } = start
    const from = date.toPlainDateTime(time)
    const [ends] = stampsOf(event.DTEND, floating)
    const length = durationOf(event.DURATION?.[0])
    // It ends where it's said to, on its own zone's clock, or as long after as said by that clock, which is so every
    // day it's on but one the clocks change, else at once
    const said = ends ? wallIn(ends, zone) : length ? from.add(length) : from
    const until = Temporal.PlainDateTime.compare(said, from) > 0 ? said : from
    const nights = date.until(until.toPlainDate()).days
    const [recurrence] = event["RECURRENCE-ID"] ?? []
    const day = date.toString()
    const daysOf = (stamps: Stamp[]) => stamps.map(stamp => wallIn(stamp, zone).toPlainDate().toString())
    // An instance moved is its own day alone; a series is its rule's days, with those added, but those excepted or moved
    const repeated = !recurrence && event.RRULE?.[0] ? ruleOfRRule(event.RRULE[0].value, date, time, zone) : undefined
    const added = recurrence ? [] : daysOf(stampsOf(event.RDATE, floating))
    const excepted = recurrence ? [] : daysOf([...stampsOf(event.EXDATE, floating), ...moved.get(uid) ?? []])
    const base = repeated ? (added.length ? any(repeated, on(...added)) : repeated) : on(day, ...added)
    return [{
      uid:         recurrence ? `${uid}/${recurrence.value}` : uid,
      title:       textOf(event.SUMMARY?.[0]).trim(),
      where:       textOf(event.LOCATION?.[0]).trim(),
      description: textOf(event.DESCRIPTION?.[0]),
      ...event.URL?.[0] && { url: event.URL[0].value.trim() },
      zone,
      day,
      session:     {
        rule:  excepted.length ? except(base, on(...excepted)) : base,
        start: clockOf(time),
        end:   clockOf(until.toPlainTime()),
        ...nights > 0 && { nights }
      }
    }]
  })
}

//#endregion

//#region Writing

/** Octets a content line may hold, the leading space of a continuation line included */
export const LINE = 75

const encoder = new TextEncoder()

/** A line folded so that no physical line exceeds 75 octets, breaking only between characters (RFC 5545 3.1) */
export const fold = (line: string) => {
  const out: string[] = []
  let piece = ""
  let octets = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    if (octets + size > (out.length ? LINE - 1 : LINE)) {
      out.push(piece)
      piece = ""
      octets = 0
    }
    piece += char
    octets += size
  }
  out.push(piece)
  return out.join("\r\n ")
}

const escape = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n")

/** An instant as a UTC date-time, "20261215T045959Z" */
export const utc = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "")

/** A day and a time of day, "HH:MM", as a local date-time, "20261027T141000" */
const local = (day: Temporal.PlainDate, time: string) =>
  `${day.toString().replaceAll("-", "")}T${time.replace(":", "")}00`

const byDay = (days: readonly Weekday[]) =>
  WEEKDAYS.flatMap((day, i) => days.includes(day) ? [CODES[i]] : []).join(",")

/** The RRULE that says a rule, but for where it starts and ends, where one can: weekly days, every nth week of them, an nth of the month */
const rruleOf = (rule: Rule): string | undefined => {
  if ("weekly" in rule && rule.weekly.length)
    return `FREQ=WEEKLY;BYDAY=${byDay(rule.weekly)}`
  if ("nth" in rule)
    return rule.weekday ? `FREQ=MONTHLY;BYDAY=${rule.nth}${CODES[WEEKDAYS.indexOf(rule.weekday)]}` : `FREQ=MONTHLY;BYMONTHDAY=${rule.nth}`
  if ("every" in rule && (rule.unit ?? "week") === "week" && "weekly" in rule.of && rule.of.weekly.length)
    return `FREQ=WEEKLY;INTERVAL=${rule.every};WKST=MO;BYDAY=${byDay(rule.of.weekly)}`
}

/** A part of a rule one RRULE can say, and the days it's bounded to */
type Skeleton = { rule: Rule, rrule: string, from: Day, until: Day }

const skeletonsOf = (rule: Rule, from: Day, until: Day): Skeleton[] => {
  const rrule = rruleOf(rule)
  if (rrule)
    return [{ rule, rrule, from, until }]
  if ("any" in rule)
    return rule.any.flatMap(one => skeletonsOf(one, from, until))
  if ("between" in rule) {
    const [first, last = until] = rule.between
    return skeletonsOf(rule.of, first > from ? first : from, last < until ? last : until)
  }
  return "except" in rule ? skeletonsOf(rule.of, from, until) : []
}

/** One VEVENT's when: its first day, and where it repeats, its RRULE, the last day that runs to, and its days to except */
export type Plan = { first: Temporal.PlainDate, rrule?: string, until?: Day, exdates: Temporal.PlainDate[] }

/**
 * A rule as the VEVENTs that say it, soonest first: each skeleton's, then one for each day none of them tells. None
 * for a rule with no first or last day
 */
export const plansOf = (rule: Rule): Plan[] => {
  const { from, until } = boundsOf(rule)
  if (from === undefined || until === undefined || from > until)
    return []
  const first = plainDay(from)
  const days = first.until(plainDay(until)).days + 1
  /** The rule's days no VEVENT tells yet */
  const untold = new Set(occurrences(rule, first, days).map(String))
  const plans = skeletonsOf(rule, from, until).flatMap((skeleton): Plan[] => {
    const all = occurrences(between(skeleton.from, skeleton.until, skeleton.rule), first, days)
    const start = all.findIndex(day => untold.has(day.toString()))
    if (start < 0)
      return []
    const its = all.slice(start)
    // A day of its own that the rule doesn't fall on, or that's told already, is excepted
    const exdates = its.filter(day => !untold.delete(day.toString()))
    return [{ first: its[0], rrule: skeleton.rrule, until: skeleton.until, exdates }]
  })
  return [...plans, ...[...untold].map(day => ({ first: plainDay(day), exdates: [] }))]
    .sort((a, b) => Temporal.PlainDate.compare(a.first, b.first))
}

/** Something to write: what it is, where, and when as a session on Durham's clock; its UID names it for good */
export type Entry = { uid: string, title: string, session: Session, where?: string, description?: string, url?: string }

/** An entry's VEVENTs: the first under its UID, any other under its UID and the day it starts */
const veventsFor = ({ uid, title, session, where, description, url }: Entry, now: number) =>
  plansOf(session.rule).flatMap(({ first, rrule, until, exdates }, i) => [
    "BEGIN:VEVENT",
    `UID:${i ? `${first}-${uid}` : uid}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART;TZID=${TIME_ZONE}:${local(first, session.start)}`,
    `DTEND;TZID=${TIME_ZONE}:${local(first.add({ days: session.nights ?? 0 }), session.end)}`,
    // To the last instant of the last day on Durham's clock, in UTC: the rule's final occurrence is never later
    ...rrule ? [`RRULE:${rrule};UNTIL=${utc(instantAt(plainDay(until!).add({ days: 1 }), "00:00") - 1000)}`] : [],
    ...exdates.map(day => `EXDATE;TZID=${TIME_ZONE}:${local(day, session.start)}`),
    `SUMMARY:${escape(title)}`,
    ...description ? [`DESCRIPTION:${escape(description)}`] : [],
    ...where ? [`LOCATION:${escape(where)}`] : [],
    ...url ? [`URL:${url}`] : [],
    "END:VEVENT"
  ])

/** A calendar file of some entries, named, stamped with when it was written. One subscribed to says how often to ask again */
export const writeCalendar = (name: string, entries: readonly Entry[], now: number, refresh?: string) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//notunh//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escape(name)}`,
    ...refresh ? [`REFRESH-INTERVAL;VALUE=DURATION:${refresh}`, `X-PUBLISHED-TTL:${refresh}`] : [],
    "BEGIN:VTIMEZONE",
    `TZID:${TIME_ZONE}`,
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "TZNAME:EDT",
    "DTSTART:19700308T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "TZNAME:EST",
    "DTSTART:19701101T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...entries.flatMap(entry => veventsFor(entry, now)),
    "END:VCALENDAR"
  ].map(fold).join("\r\n") + "\r\n"

//#endregion
