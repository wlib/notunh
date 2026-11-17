// What happens again and again that only a page of UNH's says, as no calendar lists it: language conversation
// hours, open climbs, drop-ins. Each series is kept by hand in curated.json, from a lead (leads.mts) someone judged,
// with the page it came from, the passage its times were read from word for word, and the day the page last said
// so. A series is its sessions (src/shared/recur.mts): each a rule saying its days, the dates its page names where
// it names them, else its wording, and the times it starts and ends, so a café on Tuesdays at one time and
// Thursdays at another is one series. Every session's rule has a last day, usually its term's, so a series
// nobody checks again ends on its own. Pure

import * as v from "valibot"
import { type Event, SHORT, Text } from "./event.mts"
import type { Matcher } from "./sources.mts"
import type { Entry } from "../shared/ics.mts"
import { Session, boundsOf, spansOf } from "../shared/recur.mts"
import { plainDay } from "../shared/temporal.mts"
import { type Day, Day as DaySchema } from "../shared/time.mts"

export const Series = v.object({
  /** What it is, as its page names it: "Russian Conversation Hour" */
  title:    v.pipe(Text(SHORT), v.minLength(1)),
  /** Where, as its page writes it, which places it on the map: "Murkland G10 Lounge" */
  where:    v.pipe(Text(SHORT), v.minLength(1)),
  /** When: each a rule with a last day, and the times it starts and ends that day */
  sessions: v.pipe(
    v.array(v.pipe(
      Session,
      v.check(({ start, end, nights }) => start < end && !nights, "A session ends after it starts, the same day"),
      v.check(({ rule }) => boundsOf(rule).until !== undefined, "A session's rule has a last day")
    )),
    v.minLength(1)
  ),
  /** The page that says so, and what it says, word for word */
  url:      v.pipe(v.string(), v.url(), v.startsWith("https://")),
  passage:  v.pipe(v.string(), v.minLength(1)),
  /** The day someone last read the page saying so */
  checked:  DaySchema
})
export type Series = v.InferOutput<typeof Series>

export const Curated = v.array(Series)

/** A series' name in its sessions' ids and its own address, the same each night: its title's words */
export const slugOf = (title: string) =>
  title.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/** The slug of the series an event is a session of, by its id, if it's one's */
export const slugIn = (id: string) =>
  id.match(/^curated:(.+)-\d{4}-\d\d-\d\d-\d{4}$/)?.[1]

/** The series' sessions over some Durham days from one as events, each at its place where its where names one */
export const fromCurated = (series: readonly Series[], from: Day, days: number, match: Matcher): Event[] =>
  series.flatMap(one => one.sessions.flatMap(session => spansOf(session, plainDay(from), days).map(({ day, start, end }) => ({
    id:      `curated:${slugOf(one.title)}-${day}-${session.start.replace(":", "")}`,
    title:   one.title,
    start,
    end,
    place:   match(one.where),
    where:   one.where,
    source:  "curated" as const,
    url:     one.url,
    checked: one.checked
  }))))

/** A series as calendar entries, one for each session, named for good by its title and when it starts */
export const entriesOf = (one: Series): Entry[] =>
  one.sessions.map(session => ({
    uid:         `curated-${slugOf(one.title)}-${session.start.replace(":", "")}@notunh.app`,
    title:       one.title,
    where:       one.where,
    description: one.passage,
    url:         one.url,
    session
  }))
