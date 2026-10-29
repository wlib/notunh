// What a link to one of the map's pages, or a pin's, previews as in iMessage, Instagram, Discord and Slack: what kind
// of thing it is, its title, and a line or two saying when and where, which the Worker puts in the page's head and
// draws as its card (worker/preview.mts). Made from the same data the pages read, at an instant, on Durham's clock,
// and only ever of what the page itself shows anyone: an instructor's address, hidden or not, is never said

import { type Section, type Term, KINDS, codeOf, courseOf } from "../courses/course.mts"
import type { Person } from "../courses/people.mts"
import { daysOf, patternsOf } from "../courses/saved.mts"
import type { GazetteerPlace } from "../places/gazetteer.mts"
import type { Area } from "../parking/model.mts"
import type { Listed } from "../programs/program.mts"
import type { Space } from "../courses/bookings.mts"
import type { FeedData } from "../transit/feed.mts"
import { TIME_ZONE, localDay } from "../shared/time.mts"
import { type Event, type Pin, whereOf } from "./event.mts"
import { isUnset } from "./marks.mts"

export type Preview = {
  /** What kind of thing the page is, over its title: "Event", "Building", "CS 518 (01) · Lecture · Fall 2026" */
  kind:  string,
  title: string,
  /** When, then where, or what else says most about it; the card draws the first strong and the rest after it */
  lines: string[]
}

/** The line a preview's description is: its lines, joined */
export const describe = ({ lines }: Pick<Preview, "lines">) =>
  lines.filter(Boolean).join(" · ")

const clock = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" })
const date = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric" })
// A meeting's minutes after midnight, as instants on UTC's clock
const hours = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })

/** Intl's thin and narrow spaces as plain ones, as every font has those and every crawler shows them */
export const plain = (text: string) =>
  text.replace(/[  ]/g, " ")

/**
 * When an event is: "Thu, Oct 30 1:30 – 2:40 PM", "Thu, Oct 30 7:00 PM – Fri, Oct 31 1:00 AM", or "Time to pick". Always
 * its date, never "Today", as a preview is kept and shown for days after it's fetched
 */
export const whenOf = (event: Event | Pin) => {
  if (isUnset(event))
    return "Time to pick"
  const { start, end } = event
  return plain(
    end <= start                          ? `${date.format(start)} ${clock.format(start)}` :
    localDay(end) === localDay(start)     ? `${date.format(start)} ${clock.formatRange(start, end)}` :
                                            `${date.format(start)} ${clock.format(start)} – ${date.format(end)} ${clock.format(end)}`
  )
}

/** An event's, or a pin's, with how many are going to a pin that has a time */
export const eventPreview = (event: Event | Pin): Preview => ({
  kind:  event.source === "pin" ? "Student event" : "Event",
  title: event.title,
  lines: [whenOf(event), whereOf(event), "going" in event && event.going ? `${event.going} going` : ""].filter(Boolean)
})

/** An OpenStreetMap kind as words: "fast_food" as "Fast food" */
const kindName = (kind: string) =>
  kind[0].toUpperCase() + kind.slice(1).replaceAll("_", " ")

/** A place's: its kind, and what's on there next within the events given, else what the page offers */
export const placePreview = (place: Pick<GazetteerPlace, "name" | "kind">, events: readonly Event[], now: number): Preview => {
  const next = events.filter(event => event.place === place.name && event.end > now).sort((a, b) => a.start - b.start)[0]
  return {
    kind:  kindName(place.kind),
    title: place.name,
    lines: next ? [`Next: ${next.title}`, whenOf(next)] : ["Directions by bus or on foot"]
  }
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** A meeting's days and hours: "Tue Thu 2:10 – 3:30 PM", or "Arranged" for one without days */
export const meetingWhen = ({ days, start, end }: Pick<Section["meetings"][number], "days" | "start" | "end">) =>
  days ? plain(`${daysOf(days).map(day => WEEKDAYS[day]).join(" ")} ${hours.formatRange(start * 60_000, end * 60_000)}`) : "Arranged"

/** A section's weekly patterns: "Tue Thu 2:10 – 3:30 PM · Fri 9:10 – 10:00 AM", or "Arranged" */
export const weeklyOf = (section: Section) => {
  const patterns = patternsOf(section)
  return patterns.length ? patterns.map(meetingWhen).join(" · ") : "Arranged"
}

/** Where a section meets: each room once, "Kingsbury N343 · Kingsbury N113" */
export const roomsOf = (section: Section) =>
  [...new Set((patternsOf(section).length ? patternsOf(section) : section.meetings).map(({ where }) => where))].join(" · ")

/** A section's: its code, kind and term, title, when it meets each week, and where */
export const sectionPreview = (term: Pick<Term, "name">, section: Section): Preview => ({
  kind:  [codeOf(section), KINDS[section.kind] ?? section.kind, term.name].join(" · "),
  title: section.title,
  lines: [weeklyOf(section), roomsOf(section)].filter(Boolean)
})

/** How many of something, "1 section", "3 sections" */
const count = (n: number, one: string, other = `${one}s`) =>
  `${n} ${n === 1 ? one : other}`

/** A course's, as its page heads it, with its sections in each term given, or none where it isn't offered in them */
export const coursePreview = (code: string, terms: readonly Pick<Term, "name" | "sections">[]): Preview | undefined => {
  const offered = terms.map(term => ({ term, sections: term.sections.filter(section => courseOf(section) === code) })).filter(({ sections }) => sections.length)
  const title = offered[0]?.sections[0].title
  return title === undefined ? undefined : {
    kind:  "Course",
    title: `${code} · ${title}`,
    lines: offered.map(({ term, sections }) => `${term.name}: ${count(sections.length, "section")}`)
  }
}

/** A list of codes, the first few and how many more: "CS 518, CS 520, MATH 425 and 4 more" */
const listed = (codes: readonly string[], shown = 3) =>
  codes.length > shown ? `${codes.slice(0, shown).join(", ")} and ${codes.length - shown} more` : codes.join(", ")

/** An instructor's: their name and what they teach, never their address */
export const personPreview = (person: Pick<Person, "name" | "teaching">): Preview => ({
  kind:  "Instructor",
  title: person.name,
  lines: [`Teaches ${listed([...new Set(person.teaching.map(({ section }) => courseOf(section)))])}`, [...new Set(person.teaching.map(({ term }) => term.name))].join(", ")]
})

/** A room's: its building, and the courses meeting there in the terms given, or none for a room none meets in */
export const roomPreview = (where: string, terms: readonly Pick<Term, "sections">[], isRoom: (written: string) => boolean): Preview | undefined => {
  const meetings = terms.flatMap(term => term.sections.flatMap(section => section.meetings.filter(meeting => isRoom(meeting.where)).map(meeting => ({ section, meeting }))))
  if (!meetings.length)
    return
  const { place, where: named } = meetings[0].meeting
  return {
    kind:  place ? `Room · ${place}` : "Room",
    title: named,
    lines: [`Classes: ${listed([...new Set(meetings.map(({ section }) => courseOf(section)))])}`]
  }
}

/** A space anyone can book, by its kind, where it is, and how many it holds: "Study room · Dimond Library" */
export const spacePreview = (space: Pick<Space, "where" | "place" | "source" | "isStudy" | "capacity">): Preview => ({
  kind:  `${space.source === "rec" ? "Campus Rec" : space.isStudy ? "Study room" : "Room"} · ${space.place}`,
  title: space.where,
  lines: space.capacity ? [`Up to ${space.capacity} people`] : []
})

const PROGRAMS: Record<Listed["kind"], string> = { major: "Major", option: "Option", minor: "Minor", cognate: "Cognate", program: "Program" }

/** A program's: what kind, its title, and how many courses it names */
export const programPreview = (program: Pick<Listed, "title" | "kind">, courses: number, year: string): Preview => ({
  kind:  `${PROGRAMS[program.kind]} · Catalog ${year}`,
  title: program.title,
  lines: [`${count(courses, "course")}, what each needs, and where they meet`]
})

/** The list of programs, from a catalog's year */
export const programsPreview = (count: number, year: string): Preview => ({
  kind:  year ? `Catalog ${year}` : "Catalog",
  title: "UNH majors, minors and programs",
  lines: [`${count} programs, the courses each names, and where they meet`]
})

/** Parking near a place, or anywhere */
export const parkingPreview = (place?: string): Preview => ({
  kind:  "Parking",
  title: place ? `Parking near ${place}` : "Parking at UNH",
  lines: ["Lots and meters for your stay, with the walk"]
})

/** A parking area's */
export const areaPreview = (area: Pick<Area, "name" | "spaces" | "zone">): Preview => ({
  kind:  area.zone ? `Meters · zone ${area.zone.number}` : "Parking",
  title: area.name,
  lines: [area.spaces ? `${area.spaces} spaces` : "", "What you can park here, and till when"].filter(Boolean)
})

/** A stop's: the routes that stop there */
export const stopPreview = (feed: Pick<FeedData, "stops" | "trips" | "routes">, id: string): Preview | undefined => {
  const index = feed.stops.findIndex(stop => stop.id === id)
  if (index < 0)
    return
  const routes = new Set(feed.trips.filter(trip => trip.stops.includes(index)).map(trip => trip.route))
  const names = feed.routes.filter(route => routes.has(route.id)).map(({ name, long }) => name === long ? name : `${name} ${long}`)
  return {
    kind:  `Stop ${id}`,
    title: feed.stops[index].name,
    lines: [names.length ? `Buses: ${listed(names)}` : "Wildcat Transit"]
  }
}
