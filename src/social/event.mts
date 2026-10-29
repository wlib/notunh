// The one shape everything social is: an event, which is a place, a time window, and a title. Official events are
// events the build makes from UNH's calendars (scripts/map/events.mts); a pin is an event a person makes, kept by the
// Worker (worker/social.mts). The home's week, the map's markers, Directions, the pin page, and sharing all read this
// shape and nothing else of either. Instants are epoch milliseconds
//
// A place is a gazetteer name (src/places/gazetteer.mts), never coordinates: pins are vague by design, at a building
// or a named outdoor place, with the detail in `where` as free text, like "room 164" or "behind the MUB"

import * as v from "valibot"
import type { GazetteerPlace } from "../places/gazetteer.mts"
import type { Place } from "../places/search.mts"
import { distance } from "../geo/projection.mts"
import { CAMPUS } from "../places/durham.mts"
import { type Day, addDays, dayStart, localDay } from "../shared/time.mts"
import { usable } from "../shared/json.mts"

/** Characters a title, a place's name, and a pin's `where` are kept to, and a description */
export const SHORT = 80
export const LONG = 500

/** Where events come from; a course's are dated class meetings (src/courses/course.mts), never in events.json */
export const SOURCES = ["presence", "25live", "athletics", "dserec", "rec", "pin", "course"] as const
export type Source = typeof SOURCES[number]

/** The calendars official events come from, each as a page names it, and who runs its events where that's one body, which a club's own on Wildcat Link isn't */
export const CALENDARS: Record<Exclude<Source, "pin" | "course">, { name: string, organizer?: { name: string, url: string } }> = {
  presence:  { name: "Wildcat Link" },
  "25live":  { name: "UNH Events Calendar", organizer: { name: "University of New Hampshire", url: "https://www.unh.edu" } },
  athletics: { name: "UNH Athletics", organizer: { name: "UNH Athletics", url: "https://unhwildcats.com" } },
  dserec:    { name: "UNH Club Sports", organizer: { name: "UNH Club Sports", url: "https://unh.dserec.com/online/clubsports" } },
  rec:       { name: "Campus Rec programs", organizer: { name: "UNH Campus Recreation", url: "https://crec.unh.edu" } }
}

/** The calendar an event is listed on, or none for one made here or a class */
export const calendarOf = ({ source }: Pick<Event, "source">) =>
  source === "pin" || source === "course" ? undefined : CALENDARS[source]

const Text = (max: number) =>
  v.pipe(v.string(), v.trim(), v.maxLength(max))

export const Event = v.object({
  /** Unique across sources, like "presence:take-back-the-night-4" or a pin's own id */
  id:     v.pipe(v.string(), v.minLength(1)),
  title:  v.pipe(Text(SHORT), v.minLength(1)),
  start:  v.number(),
  end:    v.number(),
  /** A gazetteer name, or none when the text names nowhere the map knows */
  place:  v.optional(Text(SHORT)),
  /** Where, as written: the room, the lawn, "behind the MUB" */
  where:  Text(SHORT),
  source: v.picklist(SOURCES),
  /** Where to read more: the source's own page, or a pin's */
  url:    v.string(),
  /** For one to sign up for, as Campus Rec's programs are: how many spots are left, and when signing up closes */
  left:   v.optional(v.number()),
  closes: v.optional(v.number()),
  /** The ids other calendars tell the same thing by, where they do (src/social/sport.mts) */
  also:   v.optional(v.array(v.string()))
})
export type Event = v.InferOutput<typeof Event>

/** The build's events.json: when it was fetched, and every event, those of a shape this code doesn't know left out */
export const EventsData = v.object({ fetched: v.number(), events: usable(Event) })
export type EventsData = v.InferOutput<typeof EventsData>

/** A candidate time of an event whose time is still to pick (marks.mts); its index among the event's times is its id */
export const Time = v.object({ start: v.number(), end: v.number() })
export type Time = v.InferOutput<typeof Time>

/** How many times an event may offer to pick from */
export const MAX_TIMES = 3

/** How many may go to an event with spots, at most */
export const MAX_SPOTS = 99

/**
 * A pin as the Worker answers for it: an event, with its description and standing. One whose time is still to pick
 * has candidate times, each marked by whoever it works for, and its window spans them; once the host sets one, its
 * window is that time, and people may go. Counts, never who
 */
export const Pin = v.object({
  ...Event.entries,
  description: Text(LONG),
  visibility:  v.picklist(["link", "public"]),
  /** The times to pick from, earliest first, or none for an event made with one time */
  times:       v.array(Time),
  /** How many marked each time */
  marks:       v.array(v.number()),
  /** The time the host set, by its index, once set */
  chosen:      v.optional(v.number()),
  /** How many are going, which is none until there's a time */
  going:       v.number(),
  /** How many may go, or no limit */
  spots:       v.optional(v.number()),
  /** What the asking device has to do with it, when it asked as itself: whether it's the host's, going, and the times it marked */
  yours:       v.optional(v.boolean()),
  isGoing:     v.optional(v.boolean()),
  marked:      v.optional(v.array(v.number()))
})
export type Pin = v.InferOutput<typeof Pin>

/** ms past its end an event is still shown and a pin still kept, as people run late */
export const LINGER = 2 * 3_600_000

/** Whether an event is on a Durham day, which may be 23 or 25 hours long, and not long over as of now */
export const isOn = (event: Event, day: string, now: number) =>
  event.end + LINGER > now && event.start < dayStart(addDays(day, 1)) && event.end >= dayStart(day)

/** The events on today's list as of now, soonest first */
export const today = <E extends Event>(events: readonly E[], now: number) =>
  events.filter(event => isOn(event, localDay(now), now)).sort((a, b) => a.start - b.start)

/** How many days after today a week's list looks: the home's, a place's, and the map's shell's */
export const WEEK = 7

/** A day to come and what's on it, soonest first, as the home's list has the days after today */
export type DayList<E extends Event = Event> = { day: Day, events: E[] }

/**
 * The days after today that have something on, in order, each with its events soonest first, up to a number of days
 * ahead: an event over several days is on each. The week the home lists under today
 */
export const upcoming = <E extends Event>(events: readonly E[], now: number, days: number): DayList<E>[] => {
  const first = addDays(localDay(now), 1)
  return Array.from({ length: days }, (_, i) => addDays(first, i))
    .map(day => ({ day, events: events.filter(event => isOn(event, day, now)).sort((a, b) => a.start - b.start) }))
    .filter(({ events }) => events.length > 0)
}

/** The gazetteer place a name means: of those by the name, the nearest the middle of campus, as search picks */
export const gazetteerPlaceOf = (gazetteer: readonly GazetteerPlace[], name: string | undefined) =>
  name === undefined ? undefined : gazetteer
    .filter(place => place.name === name)
    .sort((a, b) => distance({ lon: a.at[0], lat: a.at[1] }, CAMPUS) - distance({ lon: b.at[0], lat: b.at[1] }, CAMPUS))[0]

/** That place as a point by name, as the map marks it */
export const placeOf = (gazetteer: readonly GazetteerPlace[], name: string | undefined): Place | undefined => {
  const found = gazetteerPlaceOf(gazetteer, name)
  return found && { lat: found.at[1], lon: found.at[0], name: found.name }
}

/** The names a pin may be at: every gazetteer name once, in order */
export const placeNames = (gazetteer: readonly GazetteerPlace[]) =>
  [...new Set(gazetteer.map(place => place.name))].sort((a, b) => a.localeCompare(b, "en"))

/** Where an event is, its place and where in it, the place said once where the where already names it */
export const whereOf = ({ place, where }: Pick<Event, "place" | "where">) =>
  (place && !where.startsWith(place) ? [place, where].filter(Boolean).join(" · ") : where || place) || "Place to be decided"

/** A pin's page */
export const pinPath = (id: string) =>
  `/p/${encodeURIComponent(id)}`

