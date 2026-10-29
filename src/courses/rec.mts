// Campus Rec's facilities and what's scheduled in them, from its Innosoft Fusion site (crec.unh.edu), in the rooms'
// own shapes (bookings.mts): each facility a space, each appointment's occurrences bookings, so a court or a field
// says whether it's free, and is found, as a room is. Fusion lists its facilities as the <option>s of its schedule
// page, "CREC > Hamel Rec Center > 3rd Floor (West Gym) > Court 1 (3rd Floor)", and answers a facility's schedule as
// DevExtreme's appointments: a first occurrence on the local clock with no offset, and a recurrence rule (RFC 5545's
// as DevExtreme writes it, UNTIL in UTC) with its exceptions, also local. The window asked for doesn't trim
// recurring appointments, whose first occurrences come back from years before, so occurrences are expanded, then
// kept to the days wanted. Its titles are what's on, as anyone reads them there ("Badminton Club"), so they're the
// booking's kind. Pure

import * as v from "valibot"
import type { Booking, Space } from "./bookings.mts"
import { usable } from "../shared/json.mts"
import { type Day, addDays, atClock, dayStart, daysBetween, weekday } from "../shared/time.mts"
import { type Matcher, plain } from "../social/sources.mts"

const FUSION = "https://crec.unh.edu/Facility"

/** Campus Rec's schedule page, whose <option>s are its facilities, and where anyone can read a facility's schedule */
export const SCHEDULE = `${FUSION}/GetSchedule`

/** A facility's schedule over some days, as the page asks for it, on the local clock */
export const scheduleUrl = (facility: string, from: Day, to: Day) =>
  `${FUSION}/GetScheduleCustomAppointmentsForDevExtremeScheduler?selectedFacilityId=${facility}&start=${from}T00:00:00&end=${to}T23:59:59`

/** Who books Campus Rec's facilities, as a booking's organization */
export const CAMPUS_REC = "Campus Rec"

/**
 * The facilities of Campus Rec's schedule page that the gazetteer places: each a space at its building, or a field
 * that's a place of its own, named by the last part of its path; within the facility whose path its own begins with,
 * as a court is in its gym
 */
export const facilitiesFrom = (html: string, match: Matcher): Space[] => {
  const options = [...html.matchAll(/<option value="([0-9a-f-]{36})">([^<]*)/g)].map(([, id, text]) => ({ id, path: plain(text, 200).split(" > ").slice(1) }))
  return options.flatMap(({ id, path }): Space[] => {
    const last = path.at(-1)!
    const place = match(last) ?? match(path.join(" "))
    if (!place)
      return []
    const room = last.toLowerCase() === place.toLowerCase() ? "" : last
    const within = options.filter(other => other.path.length < path.length && other.path.every((part, i) => path[i] === part)).sort((a, b) => b.path.length - a.path.length)[0]
    return [{ id, source: "rec", where: room ? `${place} ${room}` : place, place, room, isStudy: false, ...within && { within: within.id } }]
  })
}

//#region Occurrences

const Appointment = v.object({
  Text:                v.string(),
  StartDate:           v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)),
  EndDate:             v.pipe(v.string(), v.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)),
  AllDay:              v.optional(v.boolean()),
  RecurrenceRule:      v.nullish(v.string()),
  RecurrenceException: v.nullish(v.string())
})
type Appointment = v.InferOutput<typeof Appointment>

/** RFC 5545's weekdays, Monday first, as weekday() counts */
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

/** The most days a rule with a COUNT is followed for from its first, as its occurrences are counted one by one */
const COUNTED_DAYS = 20 * 366

/** RFC 5545's UTC time, "20270806T163000Z", as an instant */
const instantOf = (stamp: string) =>
  Date.parse(stamp.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z?$/, "$1-$2-$3T$4:$5:$6Z"))

/** A local stamp, "2027-01-19T08:00:00.000" or "20270119T080000", as its day and time of day */
const localOf = (stamp: string) => {
  const [, year, month, date, hours, minutes] = stamp.match(/^(\d{4})-?(\d\d)-?(\d\d)T(\d\d):?(\d\d)/)!
  return { day: `${year}-${month}-${date}` as Day, time: `${hours}:${minutes}` }
}

/** The Sunday a day's week starts on, as Fusion's rules all say (WKST=SU) */
const sundayOf = (day: Day) =>
  addDays(day, -((weekday(day) + 1) % 7))

/** Whether a rule, of an appointment first on a day, falls on another day, COUNT and UNTIL aside */
const fallsOn = (parts: Record<string, string>, first: Day, day: Day) => {
  const interval = +(parts.INTERVAL ?? 1)
  const days = parts.BYDAY?.split(",") ?? []
  switch (parts.FREQ) {
    case "DAILY":
      return daysBetween(first, day) % interval === 0
    case "WEEKLY":
      return (days.length ? days.includes(WEEKDAYS[weekday(day)]) : weekday(day) === weekday(first)) && daysBetween(sundayOf(first), sundayOf(day)) / 7 % interval === 0
    case "MONTHLY": {
      const months = (+day.slice(0, 4) - +first.slice(0, 4)) * 12 + +day.slice(5, 7) - +first.slice(5, 7)
      if (months % interval !== 0)
        return false
      if (!days.length)
        return day.slice(8) === first.slice(8)
      // "2FR", or "FR" with BYSETPOS=2, is the second Friday; -1 the last
      const nth = Math.ceil(+day.slice(8) / 7)
      const isLast = addDays(day, 7).slice(5, 7) !== day.slice(5, 7)
      return days.some(byDay => {
        const [, ordinal, name] = byDay.match(/^([+-]?\d)?(\w\w)$/) ?? []
        const wanted = +(ordinal ?? parts.BYSETPOS ?? 0)
        return name === WEEKDAYS[weekday(day)] && (wanted === 0 || wanted === nth || wanted === -1 && isLast)
      })
    }
    default:
      return false
  }
}

/**
 * An appointment's occurrences that touch some days, each from its start to its end in epoch ms on Durham's clock,
 * as Fusion means it: those its rule makes from its first, but its exceptions, up to its COUNT or UNTIL
 */
export const occurrencesOf = (appointment: Appointment, from: Day, to: Day): { start: number, end: number }[] => {
  const first = localOf(appointment.StartDate)
  const last = localOf(appointment.EndDate)
  const span = daysBetween(first.day, last.day)
  const spanOf = (day: Day) => appointment.AllDay
    ? { start: dayStart(day), end: dayStart(addDays(day, span + 1)) }
    : { start: atClock(day, first.time), end: atClock(addDays(day, span), last.time) }
  const touches = ({ start, end }: { start: number, end: number }) =>
    start < dayStart(addDays(to, 1)) && end > dayStart(from)
  const rule = appointment.RecurrenceRule?.trim()
  if (!rule)
    return [spanOf(first.day)].filter(touches)
  const parts = Object.fromEntries(rule.split(";").filter(Boolean).map(part => part.split("=") as [string, string]))
  const until = parts.UNTIL ? instantOf(parts.UNTIL) : Infinity
  const count = parts.COUNT ? +parts.COUNT : Infinity
  const except = new Set((appointment.RecurrenceException ?? "").split(",").filter(Boolean).map(stamp => localOf(stamp).day))
  const found: { start: number, end: number }[] = []
  let made = 0
  // A COUNT counts from the first occurrence; anything else starts looking where the days asked about do, less the
  // days an occurrence spans, so a rule set years ago costs no more than one set this week
  const start = parts.COUNT || first.day > addDays(from, -span) ? first.day : addDays(from, -span)
  for (let i = 0, day = start; i <= COUNTED_DAYS && day <= to && made < count; i++, day = addDays(day, 1)) {
    // The first date itself counts only where its rule falls, as DevExtreme shows it
    if (!fallsOn(parts, first.day, day))
      continue
    const occurrence = spanOf(day)
    if (occurrence.start > until)
      break
    made++
    if (!except.has(day) && touches(occurrence))
      found.push(occurrence)
  }
  return found
}

/** A facility's bookings on some days, from its schedule's answer: each occurrence of each appointment, what's on as its kind */
export const recBookingsFrom = (json: unknown, facility: string, from: Day, to: Day): Booking[] =>
  v.parse(usable(Appointment), json).flatMap(appointment => {
    const type = appointment.Text.replace(/\s+/g, " ").trim()
    return occurrencesOf(appointment, from, to).map(({ start, end }) => ({ space: facility, start, end, type, org: CAMPUS_REC }))
  })

//#endregion
