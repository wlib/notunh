// What happens again and again that only a page of UNH's says, as no calendar lists it: language conversation
// hours, open climbs, drop-ins. Each series is kept by hand in curated.json, from a lead (leads.mts) someone judged,
// with the page it came from, the passage its times were read from word for word, and the day the page last said
// so. Each runs from a day until a day, usually its term's, so one nobody checks again ends on its own. Pure

import * as v from "valibot"
import { type Event, SHORT } from "./event.mts"
import type { Matcher } from "./sources.mts"
import { type Day, Day as DaySchema, addDays, atClock, weekday } from "../shared/time.mts"

const Clock = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/))

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

export const Series = v.pipe(
  v.object({
    /** What it is, as its page names it: "Russian Conversation Hour" */
    title:   v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SHORT)),
    /** Where, as its page writes it, which places it on the map: "Murkland G10 Lounge" */
    where:   v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SHORT)),
    /** The weekdays it's on, or none where it's on the dates it names */
    days:    v.array(v.picklist(WEEKDAYS)),
    /** The days it's on where it isn't every week, as "every other Wednesday" is, each named on its page */
    dates:   v.optional(v.array(DaySchema)),
    start:   Clock,
    end:     Clock,
    /** The first and last days it may be on, both included: usually its term's */
    from:    DaySchema,
    until:   DaySchema,
    /** The page that says so, and what it says, word for word */
    url:     v.pipe(v.string(), v.url(), v.startsWith("https://")),
    passage: v.pipe(v.string(), v.minLength(1)),
    /** The day someone last read the page saying so */
    checked: DaySchema
  }),
  v.check(({ days, dates }) => !days.length !== !dates?.length, "A series is on weekdays or on dates, not both"),
  v.check(({ start, end }) => start < end, "A series ends after it starts"),
  v.check(({ from, until }) => from <= until, "A series runs until after it starts")
)
export type Series = v.InferOutput<typeof Series>

export const Curated = v.array(Series)

/** A series' name in its sessions' ids, the same each night: its title's words */
const slugOf = (title: string) =>
  title.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/** The series' sessions over some Durham days from one as events, each at its place where its where names one */
export const fromCurated = (series: readonly Series[], from: Day, days: number, match: Matcher): Event[] =>
  series.flatMap(one => Array.from({ length: days }, (_, i) => addDays(from, i))
    .filter(day => day >= one.from && day <= one.until && (one.dates?.includes(day) || one.days.includes(WEEKDAYS[weekday(day)])))
    .map(day => ({
      id:      `curated:${slugOf(one.title)}-${day}-${one.start.replace(":", "")}`,
      title:   one.title,
      start:   atClock(day, one.start),
      end:     atClock(day, one.end),
      place:   match(one.where),
      where:   one.where,
      source:  "curated" as const,
      url:     one.url,
      checked: one.checked
    })))
