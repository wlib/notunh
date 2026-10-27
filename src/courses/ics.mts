// Saved sections as an iCalendar file, written on the device: one VEVENT per meeting with a weekly rule to its last
// day, EXDATEs for the no-class days it would have met, and for a swap day an RDATE where the swapped weekday meets
// and an EXDATE where the real one did. Times are local in America/New_York under a VTIMEZONE, as Apple Calendar and
// Google take them, and because DTSTART then carries a TZID, UNTIL is given in UTC as RFC 5545 requires (3.3.10).
// Every VEVENT has the DTSTAMP the RFC requires (3.6.1), and lines fold at 75 octets of UTF-8, not 75 characters, so
// an accented name never makes an overlong line. The file is a snapshot: it won't follow a room change, and its
// events aren't the app's reminders

import { type Calendar, LETTERS, letterOf } from "./calendar.mts"
import { type Meeting, type Section, type Term, KINDS, clock, codeOf, courseOf, meetingKeys, sectionUrl } from "./course.mts"
import { type Day, TIME_ZONE, addDays, atClock, weekday } from "../shared/time.mts"

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

/** Where a VEVENT's URL points, wherever the file was made */
const ORIGIN = "https://notunh.app"

/** Octets a content line may hold, the leading space of a continuation line included */
export const LINE = 75

/** A Durham day and time as a local date-time, "20261027T141000" */
const local = (day: Day, minutes: number) =>
  `${day.replaceAll("-", "")}T${clock(minutes).replace(":", "")}00`

/** An instant as a UTC date-time, "20261215T045959Z" */
export const utc = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "")

const escape = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")

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

/** The days from one to another, both included */
const eachDay = function* (from: Day, to: Day) {
  for (let day = from; day <= to; day = addDays(day, 1))
    yield day
}

/** The first day of a meeting's dates on one of its weekdays, which DTSTART must be for the rule to count it */
const firstDay = (meeting: Meeting) => {
  for (const day of eachDay(meeting.from, meeting.to))
    if (meeting.days.includes(LETTERS[weekday(day)]))
      return day
}

/** The lines of one meeting's VEVENT, or none for hours arranged or a meeting never on its own weekdays */
const vevent = (term: Pick<Term, "code">, section: Section, meeting: Meeting, key: string, calendar: Calendar, now: number) => {
  const start = meeting.days ? firstDay(meeting) : undefined
  if (start === undefined)
    return []
  const exdates: string[] = []
  const rdates:  string[] = []
  for (const day of eachDay(meeting.from, meeting.to)) {
    const real = meeting.days.includes(LETTERS[weekday(day)])
    const follows = !calendar.noClass.includes(day) && meeting.days.includes(letterOf(calendar, day, weekday(day)))
    if (real && !follows)
      exdates.push(local(day, meeting.start))
    else if (!real && follows)
      rdates.push(local(day, meeting.start))
  }
  const byday = [...meeting.days].flatMap(letter => BYDAY[LETTERS.indexOf(letter as typeof LETTERS[number])] ?? []).join(",")
  // The last instant of the last day on Durham's clock, in UTC: the rule's final occurrence is never later
  const until = utc(atClock(meeting.to, "23:59") + 59_000)
  return [
    "BEGIN:VEVENT",
    `UID:course-${term.code}-${section.crn}-${key}@notunh.app`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART;TZID=${TIME_ZONE}:${local(start, meeting.start)}`,
    `DTEND;TZID=${TIME_ZONE}:${local(start, meeting.end)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${until}`,
    ...exdates.map(date => `EXDATE;TZID=${TIME_ZONE}:${date}`),
    ...rdates.map(date => `RDATE;TZID=${TIME_ZONE}:${date}`),
    `SUMMARY:${escape(`${courseOf(section)} ${KINDS[section.kind] ?? section.kind}`)}`,
    `DESCRIPTION:${escape(`${codeOf(section)} ${section.title}${section.instructors.length ? ` · ${section.instructors.map(({ name }) => name).join(", ")}` : ""}`)}`,
    `LOCATION:${escape(meeting.where)}`,
    `URL:${ORIGIN}${sectionUrl(term.code, section.crn)}`,
    "END:VEVENT"
  ]
}

/** The file: every meeting of the sections given, under one calendar named for their terms, stamped with when it was written */
export const icsOf = (saved: readonly { term: Pick<Term, "code" | "name">, section: Section }[], calendar: Calendar, now = Date.now()) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//notunh//courses//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escape(`UNH ${[...new Set(saved.map(({ term }) => term.name))].join(", ") || "classes"}`)}`,
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
    ...saved.flatMap(({ term, section }) => {
      const keys = meetingKeys(section)
      return section.meetings.flatMap((meeting, i) => vevent(term, section, meeting, keys[i], calendar, now))
    }),
    "END:VCALENDAR"
  ].map(fold).join("\r\n") + "\r\n"
