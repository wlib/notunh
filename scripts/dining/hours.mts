// Reads the dining halls' hours: from UNH Dining's page for each hall, which is right, and from Nutrislice,
// which has every hall's usual hours but also keeps ones UNH has dropped, like Philbrook on weekends

import type { Hours, Span } from "../../src/dining/menus.mts"
import { addDays, weekday, type Day } from "../../src/shared/time.mts"

/** Each hall's page on unh.edu/dining/facility/ */
export const UNH_PAGES: Record<string, string> = {
  "holloway-commons-dining": "holloway-commons-hoco",
  "philbrook-dining-hall":   "philbrook-dining-hall"
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
const DAY = 1440

/** A day's spans on UNH's page, and the note beside them when the hours are a one-off */
export type UnhDay = { spans: Span[], note?: string }

/** Like "7:15 am", "12:00 pm", "noon", or "midnight", as minutes after midnight */
const parseTime = (text: string) => {
  if (/^noon$/i.test(text))
    return 720
  if (/^midnight$/i.test(text))
    return 0
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i)
  if (!match || +match[1] < 1 || +match[1] > 12 || +(match[2] ?? 0) > 59)
    return undefined
  return (+match[1] % 12 + (match[3].toLowerCase() === "p" ? 12 : 0)) * 60 + +(match[2] ?? 0)
}

/** A closing time at or before the opening is the next morning's */
const span = (open: number, close: number): Span =>
  [open, close <= open ? close + DAY : close]

const parseWeekday = (text: string) =>
  WEEKDAYS.findIndex(day => text.toLowerCase().startsWith(day))

const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The week in the Hours block on a hall's UNH Dining page, Monday first: each day's label, like "Mon - Fri:",
 * then its hours, like "7:15 am-9:00 pm", or "Closed", and any note. Undefined unless it names every day once
 */
export const parseUnhHours = (html: string): UnhDay[] | undefined => {
  const days: (UnhDay | undefined)[] = Array(7).fill(undefined)
  let current: UnhDay[] = []
  // The block is Drupal's office hours, marking each part with a class
  for (const [, part, raw] of html.matchAll(/class="[^"]*\boffice-hours__item-(label|hours|comment)\b[^"]*"[^>]*>([^<]*)</g)) {
    const text = decode(raw)
    if (part === "label") {
      const label = text.match(/^(\w{3})\w*(?:\s*[-–]\s*(\w{3})\w*)?:?$/)
      const [first, last] = label ? [parseWeekday(label[1]), parseWeekday(label[2] ?? label[1])] : [-1, -1]
      if (first < 0 || last < 0)
        return undefined
      current = []
      for (let day = first; ; day = (day + 1) % 7) {
        if (days[day])
          return undefined
        const entry: UnhDay = { spans: [] }
        days[day] = entry
        current.push(entry)
        if (day === last)
          break
      }
    }
    else if (part === "hours") {
      const hours = text.match(/^(.+?)\s*[-–]\s*(.+)$/)
      const [open, close] = hours ? [parseTime(hours[1]), parseTime(hours[2])] : []
      if (open === undefined || close === undefined)
        return undefined
      current.forEach(day => day.spans.push(span(open, close)))
    }
    // "Closed" alone says no more than having no hours does
    else if (text && !(/^closed$/i.test(text) && current.every(day => !day.spans.length)))
      current.forEach(day => day.note = day.note ? `${day.note}; ${text}` : text)
  }

  return days.every(Boolean) ? days as UnhDay[] : undefined
}

/** The parts of a Nutrislice school with its hours, like mon_start: "07:15:00" */
export type NutrisliceSchool = Partial<Record<
  `${typeof WEEKDAYS[number]}_${"enabled" | "is_24_hours" | "start" | "end"}`,
  boolean | string | null
>>

const clockMinutes = (time: unknown) => {
  const match = typeof time === "string" && time.match(/^(\d{2}):(\d{2})/)
  return match ? +match[1] * 60 + +match[2] : undefined
}

/** Nutrislice's week for a school, Monday first; undefined when any open day is missing a time */
export const nutrisliceHours = (school: NutrisliceSchool): Span[][] | undefined => {
  const week = WEEKDAYS.map((day): Span[] | undefined => {
    if (!school[`${day}_enabled`])
      return []
    if (school[`${day}_is_24_hours`])
      return [[0, DAY]]
    const [open, close] = [clockMinutes(school[`${day}_start`]), clockMinutes(school[`${day}_end`])]
    return open === undefined || close === undefined ? undefined : [span(open, close)]
  })
  return week.every(Boolean) ? week as Span[][] : undefined
}

/**
 * A hall's hours: UNH's when its page could be read, else Nutrislice's. UNH's page shows this week, Sunday to Saturday,
 * where a day with a note, like an early close, is a one-off for that date, so that weekday's usual hours are Nutrislice's
 */
export const hallHours = (unh: UnhDay[] | undefined, nutrislice: Span[][] | undefined, today: Day): Hours | undefined => {
  if (!unh)
    return nutrislice && { week: nutrislice }

  // The page's week starts on the Sunday, which is last in ours
  const sunday = addDays(today, -((weekday(today) + 1) % 7))
  const special: NonNullable<Hours["special"]> = {}
  const week = unh.map(({ spans, note }, i) => {
    if (!note)
      return spans
    const day = addDays(sunday, (i + 1) % 7)
    if (day >= today)
      special[day] = { spans, note }
    return nutrislice?.[i] ?? spans
  })
  return Object.keys(special).length ? { week, special } : { week }
}
