// Whether a hall is open, from its weekly hours, on Durham's wall clock

import type { Hours, Span } from "./menus.mts"
import { addDays, weekday, type Day } from "../shared/time.mts"

const DAY = 1440

/** A time on Durham's wall clock: a day, and minutes after its midnight */
export type WallTime = { day: Day, minute: number }

export type Status =
  | { isOpen: true, closes: WallTime }
  | { isOpen: false, opens?: WallTime }

/** A day's open spans: its one-off hours if it has them, else its weekday's */
export const spansOn = (hours: Hours, day: Day): Span[] =>
  hours.special?.[day]?.spans ?? hours.week[weekday(day)]

/** Open now, and when it closes, or else when it next opens within a week */
export const status = (hours: Hours, now: WallTime): Status => {
  // Every span from yesterday, which can run past midnight, to a week out, in minutes from today's midnight,
  // with spans that touch joined, so a hall open past midnight into the next day's hours closes when it really does
  const spans: Span[] = []
  for (let offset = -1; offset <= 7; offset++)
    for (const [open, close] of spansOn(hours, addDays(now.day, offset)).toSorted((a, b) => a[0] - b[0])) {
      const last = spans.at(-1)
      if (last && open + offset * DAY <= last[1])
        last[1] = Math.max(last[1], close + offset * DAY)
      else
        spans.push([open + offset * DAY, close + offset * DAY])
    }

  const at = (minutes: number): WallTime =>
    ({ day: addDays(now.day, Math.floor(minutes / DAY)), minute: ((minutes % DAY) + DAY) % DAY })

  const current = spans.find(([open, close]) => open <= now.minute && now.minute < close)
  if (current)
    return { isOpen: true, closes: at(current[1]) }
  const next = spans.find(([open]) => open > now.minute)
  return next ? { isOpen: false, opens: at(next[0]) } : { isOpen: false }
}

/** A wall time as a Date to format in UTC, the way days are, so Durham's clock changes can't move it */
export const wallDate = ({ day, minute }: WallTime) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + minute * 60_000)
