// Durham's clock and calendar, which every bus schedule, menu, and laundry room runs on. Instants are epoch
// milliseconds as Date.now() gives them, except where times are compared with the timetable, which counts schedule
// seconds

import * as v from "valibot"

export const TIME_ZONE = "America/New_York"
export const HOUR      = 3_600_000
export const DAY       = 86_400_000

/** A calendar day in Durham as YYYY-MM-DD, which sorts and compares as text */
export const Day = v.pipe(v.string(), v.isoDate())
export type Day = v.InferOutput<typeof Day>

const dayFormat    = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE })
const hourFormat   = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" })
const minuteFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric", hourCycle: "h23" })
const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
const clockFormat  = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" })

export const localDay = (ms: number): Day =>
  dayFormat.format(ms)

/** The hour in Durham, 0 to 23 */
export const localHour = (ms: number) =>
  +hourFormat.format(ms)

/** Minutes after midnight in Durham, 0 to 1439 */
export const localMinutes = (ms: number) => {
  const parts = Object.fromEntries(minuteFormat.formatToParts(ms).map(({ type, value }) => [type, value]))
  return +parts.hour * 60 + +parts.minute
}

/** Milliseconds Durham is ahead of UTC at a moment: negative, and an hour less in winter */
export const offsetAt = (ms: number) => {
  const offset = offsetFormat.format(ms).match(/GMT([+-])(\d+):(\d+)/)
  return offset ? (offset[1] === "-" ? -1 : 1) * (+offset[2] * 60 + +offset[3]) * 60_000 : 0
}

/**
 * Epoch milliseconds of midnight in Durham starting a day, which is 23 to 25 hours before the next one's. The offset
 * is the one in force at that midnight, found by guessing from the offset at UTC's midnight and correcting once.
 * Durham's clocks change at 2 AM, never between the two instants, so one correction is exact
 */
export const dayStart = (day: Day) => {
  const utc = Date.parse(`${day}T00:00:00Z`)
  return utc - offsetAt(utc - offsetAt(utc))
}

/**
 * Epoch milliseconds of a time of day on Durham's clock, "HH:MM", on a day. The offset is the one in force at that
 * time, found as dayStart finds midnight's, so an hour that the clocks skip or repeat lands an hour off at worst
 */
export const atClock = (day: Day, time: string) => {
  const [hours, minutes] = time.split(":").map(Number)
  const guess = dayStart(day) + (hours * 60 + minutes) * 60_000
  return guess + offsetAt(dayStart(day)) - offsetAt(guess)
}

/** A moment as "HH:MM" on Durham's clock, as atClock takes it back and a time field holds it */
export const hhmm = (ms: number) =>
  `${String(Math.floor(localMinutes(ms) / 60)).padStart(2, "0")}:${String(localMinutes(ms) % 60).padStart(2, "0")}`

/**
 * A moment on Durham's clock as ISO 8601 with its offset, "2026-10-30T13:30:00-04:00", as structured data dates
 * events, to the second
 */
export const isoOf = (ms: number) => {
  const offset = offsetAt(ms)
  const minutes = Math.abs(offset) / 60_000
  const sign = offset < 0 ? "-" : "+"
  return `${new Date(Math.floor(ms / 1000) * 1000 + offset).toISOString().slice(0, 19)}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

/** A moment as read off Durham's clock, like "2:35 PM", where there's no element to format it (src/shell/intl.tsx) */
export const clockOf = (ms: number) =>
  clockFormat.format(ms)

// A day's noon in UTC, which is on that day whatever the clocks do
const noonOf = (day: Day) =>
  Date.parse(`${day}T12:00:00Z`)

export const addDays = (day: Day, days: number): Day =>
  new Date(noonOf(day) + days * DAY).toISOString().slice(0, 10)

export const daysBetween = (from: Day, to: Day) =>
  Math.round((noonOf(to) - noonOf(from)) / DAY)

/** Epoch ms of a time of day, "HH:MM", as it next comes on Durham's clock after `now`: today's, or tomorrow's once that's past */
export const nextAt = (time: string, now: number) => {
  const today = atClock(localDay(now), time)
  return today > now ? today : atClock(addDays(localDay(now), 1), time)
}

/** 0 for Monday through 6 for Sunday */
export const weekday = (day: Day) =>
  (new Date(noonOf(day)).getUTCDay() + 6) % 7
