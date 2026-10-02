// Whether a hall is open, from its weekly hours, on Durham's wall clock

import type { Hours, Span } from "./menus.mts"

const DAY = 1440

/** A time on Durham's wall clock: a YYYY-MM-DD day, and minutes after its midnight */
export type WallTime = { date: string, minute: number }

export type Status =
  | { isOpen: true, closes: WallTime }
  | { isOpen: false, opens?: WallTime }

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** A day's open spans: its one-off hours if it has them, else its weekday's */
export const spansOn = (hours: Hours, date: string): Span[] =>
  hours.special?.[date]?.spans ?? hours.week[new Date(`${date}T12:00:00Z`).getUTCDay()]

/** Open now, and when it closes, or else when it next opens within a week */
export const status = (hours: Hours, now: WallTime): Status => {
  // Every span from yesterday, which can run past midnight, to a week out, in minutes from today's midnight,
  // with spans that touch joined, so a hall open past midnight into the next day's hours closes when it really does
  const spans: Span[] = []
  for (let offset = -1; offset <= 7; offset++)
    for (const [open, close] of spansOn(hours, addDays(now.date, offset)).toSorted((a, b) => a[0] - b[0])) {
      const last = spans.at(-1)
      if (last && open + offset * DAY <= last[1])
        last[1] = Math.max(last[1], close + offset * DAY)
      else
        spans.push([open + offset * DAY, close + offset * DAY])
    }

  const at = (minutes: number): WallTime =>
    ({ date: addDays(now.date, Math.floor(minutes / DAY)), minute: ((minutes % DAY) + DAY) % DAY })

  const current = spans.find(([open, close]) => open <= now.minute && now.minute < close)
  if (current)
    return { isOpen: true, closes: at(current[1]) }
  const next = spans.find(([open]) => open > now.minute)
  return next ? { isOpen: false, opens: at(next[0]) } : { isOpen: false }
}

/** A wall time as a Date to format in UTC, the way days are, so Durham's clock changes can't move it */
export const wallDate = ({ date, minute }: WallTime) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + minute * 60_000)
