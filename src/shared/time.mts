// Durham's clock and calendar, which every bus schedule, menu, and laundry room runs on. Instants are epoch
// milliseconds as Date.now() gives them, except where times are compared with the timetable, which counts seconds

export const TIME_ZONE = "America/New_York"
export const HOUR      = 3_600_000
export const DAY       = 86_400_000

/** A calendar day in Durham as YYYY-MM-DD, which sorts and compares as text */
export type Day = string

const dayFormat    = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE })
const hourFormat   = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" })
const minuteFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric", hourCycle: "h23" })
const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })

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
 * Epoch milliseconds of midnight in Durham starting a day, which is 23 to 25 hours before the next one's. The
 * offset is the one at that midnight, found from the one at UTC's, which differs only where clocks change between
 * the two, as Durham's never do (they change at 2 AM)
 */
export const dayStart = (day: Day) => {
  const utc = Date.parse(`${day}T00:00:00Z`)
  return utc - offsetAt(utc - offsetAt(utc))
}

// A day's noon in UTC, which is on that day whatever the clocks do
const noonOf = (day: Day) =>
  Date.parse(`${day}T12:00:00Z`)

export const addDays = (day: Day, days: number): Day =>
  new Date(noonOf(day) + days * DAY).toISOString().slice(0, 10)

export const daysBetween = (from: Day, to: Day) =>
  Math.round((noonOf(to) - noonOf(from)) / DAY)

/** 0 for Monday through 6 for Sunday */
export const weekday = (day: Day) =>
  (new Date(noonOf(day)).getUTCDay() + 6) % 7
