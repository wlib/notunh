// Events as calendar entries (src/shared/ics.mts): one of UNH's, or one a person made, on its one day at its times on
// Durham's clock, linking to where it's from; a curated series' own are its sessions' (curated.mts). Pure

import { type Event, whereOf } from "./event.mts"
import type { Entry } from "../shared/ics.mts"
import { on } from "../shared/recur.mts"
import { Temporal } from "../shared/temporal.mts"
import { TIME_ZONE } from "../shared/time.mts"

const local = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(TIME_ZONE)

/** An event as an entry: the day it starts, to the time it ends, however many nights on */
export const entryOf = (event: Pick<Event, "id" | "title" | "start" | "end" | "place" | "where" | "url"> & { description?: string }): Entry => {
  const [start, end] = [local(event.start), local(event.end)]
  const nights = start.toPlainDate().until(end.toPlainDate()).days
  return {
    uid:     `${event.id}@notunh.app`,
    title:   event.title,
    where:   whereOf(event),
    ...event.description && { description: event.description },
    ...event.url.startsWith("https://") && { url: event.url },
    session: {
      rule:  on(start.toPlainDate().toString()),
      start: start.toPlainTime().toString({ smallestUnit: "minute" }),
      end:   end.toPlainTime().toString({ smallestUnit: "minute" }),
      ...nights > 0 && { nights }
    }
  }
}

/** The file an event, a series, a section or a feed is served as, by what it's of: "/api/calendar/event/<id>.ics" */
export const calendarPath = (...parts: string[]) =>
  `/api/calendar/${parts.map(encodeURIComponent).join("/")}.ics`
