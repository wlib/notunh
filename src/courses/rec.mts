// Campus Rec's facilities and what's scheduled in them, from its Innosoft Fusion site (crec.unh.edu), in the rooms'
// own shapes (bookings.mts): each facility a space, each appointment's occurrences bookings, so a court or a field
// says whether it's free, and is found, as a room is. Fusion lists its facilities as the <option>s of its schedule
// page, "CREC > Hamel Rec Center > 3rd Floor (West Gym) > Court 1 (3rd Floor)", and answers a facility's schedule as
// DevExtreme's appointments: a first occurrence on the local clock with no offset, and a recurrence rule (RFC 5545's
// as DevExtreme writes it, UNTIL in UTC) with its exceptions, also local. The window asked for doesn't trim
// recurring appointments, whose first occurrences come back from years before, so each is read as a session
// (src/shared/ics.mts) and asked only about the days wanted. Its titles are what's on, as anyone reads them there
// ("Badminton Club"), so they're the booking's kind. Pure

import * as v from "valibot"
import type { Booking, Space } from "./bookings.mts"
import { usable } from "../shared/json.mts"
import { ruleOfRRule } from "../shared/ics.mts"
import { except, on, spansOf } from "../shared/recur.mts"
import { Temporal, instantAt, plainDay } from "../shared/temporal.mts"
import { type Day, TIME_ZONE } from "../shared/time.mts"
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

/**
 * An appointment's occurrences that touch some days, each from its start to its end in epoch ms on Durham's clock,
 * as Fusion means it: those its rule makes from its first (ruleOfRRule), but its exceptions. One over several days,
 * or a whole day, runs through that many nights
 */
export const occurrencesOf = (appointment: Appointment, from: Day, to: Day): { start: number, end: number }[] => {
  const first = Temporal.PlainDateTime.from(appointment.StartDate)
  const last = Temporal.PlainDateTime.from(appointment.EndDate)
  const day = first.toPlainDate()
  const nights = day.until(last.toPlainDate()).days + (appointment.AllDay ? 1 : 0)
  const times = appointment.AllDay
    ? { start: "00:00", end: "00:00", nights }
    : { start: first.toPlainTime().toString({ smallestUnit: "minute" }), end: last.toPlainTime().toString({ smallestUnit: "minute" }), nights }
  const rrule = appointment.RecurrenceRule?.trim()
  const rule = rrule ? ruleOfRRule(rrule, day, first.toPlainTime(), TIME_ZONE) ?? on(day.toString()) : on(day.toString())
  const exceptions = (appointment.RecurrenceException ?? "").split(",").filter(Boolean).map(stamp => Temporal.PlainDateTime.from(stamp).toPlainDate().toString())
  // An occurrence that began up to its nights before the days asked about still touches them
  const start = plainDay(from).subtract({ days: nights })
  const [opens, closes] = [instantAt(plainDay(from), "00:00"), instantAt(plainDay(to).add({ days: 1 }), "00:00")]
  return spansOf({ rule: except(rule, on(...exceptions)), ...times }, start, start.until(plainDay(to)).days + 1)
    .filter(({ start, end }) => start < closes && end > opens)
    .map(({ start, end }) => ({ start, end }))
}

/** A facility's bookings on some days, from its schedule's answer: each occurrence of each appointment, what's on as its kind */
export const recBookingsFrom = (json: unknown, facility: string, from: Day, to: Day): Booking[] =>
  v.parse(usable(Appointment), json).flatMap(appointment => {
    const type = appointment.Text.replace(/\s+/g, " ").trim()
    return occurrencesOf(appointment, from, to).map(({ start, end }) => ({ space: facility, start, end, type, org: CAMPUS_REC }))
  })

//#endregion
