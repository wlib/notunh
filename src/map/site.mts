// What each of the map's pages is of, from the site's own data files, which the Worker reads from its assets and the
// build from its folder (a Site): its summary, whose preview heads it and draws its card (src/social/preview.mts) and
// whose parts say in its body what the app will show (src/shell/served.tsx), and for an event, the event and its
// place, for its structured data. Never more than the page itself shows anyone. No DOM

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Page, urlOf } from "./link.mts"
import { plain, areaPreview, coursePreview, eventPreview, meetingWhen, parkingPreview, personPreview, placePreview, programPreview, programsPreview, roomPreview, roomsOf, sectionPreview, stopPreview, weeklyOf, whenOf } from "../social/preview.mts"
import { type Event, type Pin, EventsData, calendarOf, gazetteerPlaceOf, whereOf } from "../social/event.mts"
import { type GazetteerPlace, Gazetteer } from "../places/gazetteer.mts"
import { Places } from "../places/buildings.mts"
import { chapterNamed } from "../places/chapters.mts"
import { type Term, type TermEntry, CoursesIndex, KINDS, TermFile, activeTerms, codeOf, courseOf, termOf } from "../courses/course.mts"
import { createPeople } from "../courses/people.mts"
import { roomKey } from "../courses/rooms.mts"
import { PrereqsIndex } from "../programs/prereqs.mts"
import { Program, Programs } from "../programs/program.mts"
import { ParkingData } from "../parking/sources.mts"
import { FeedData, scheduledFrom } from "../transit/feed.mts"
import { pathOf, roomAtSlug } from "../laundry/rooms.mts"
import { HOUR, clockOf, localDay } from "../shared/time.mts"
import type { Part, Summary } from "../shell/served.tsx"

/** The site's data files: those the map page names, by name, and the rest by their own paths, as a schema makes them */
export type Site = {
  named: <T,>(name: string, schema: StandardSchemaV1<unknown, T>) => Promise<T>,
  file:  <T,>(path: string, schema: StandardSchemaV1<unknown, T>) => Promise<T>
}

/** A page as it's of something: its summary, and the event and place it's of, where it is */
export type Resolved = Summary & { event?: Event | Pin, place?: GazetteerPlace }

/** The kinds of page that are of something, which a link to previews as, and which may be of nothing there is */
export const OF_SOMETHING: readonly Page["kind"][] = ["event", "place", "section", "course", "person", "room", "program", "parking", "area", "stop"]

/** The kinds whose pages are kept out of search: instructors, who are people */
export const UNLISTED: readonly Page["kind"][] = ["person"]

/** What a page's title adds to say it's of UNH, by its kind, unless the title says so already */
export const CONTEXTS: Partial<Record<Page["kind"], string>> = {
  event: "UNH event", place: "UNH map", section: "UNH class", course: "UNH course", person: "UNH", room: "UNH classroom",
  program: "UNH catalog", parking: "UNH parking", area: "UNH parking", stop: "UNH bus stop"
}

/** How far ahead a stop's body lists the timetable's buses, and how many of each route it says */
const SCHEDULE_HOURS = 4
const TIMES_SHOWN = 4

/** How many of what's on a place's body lists */
const ON_SHOWN = 10

/** The terms whose files are worth reading, with their sections */
export const termsOf = async (site: Site, which: (entries: readonly TermEntry[]) => readonly TermEntry[]) => {
  const index = await site.named("courses", CoursesIndex)
  return Promise.all(which(index.terms).map(async entry => termOf(index, entry, await site.file(entry.file, TermFile))))
}

/** The terms not over by an instant, which have pages worth finding */
export const notOver = (now: number) =>
  (entries: readonly TermEntry[]) => entries.filter(({ to }) => to >= localDay(now))

const sectionUrl = (term: Pick<Term, "code">, crn: string) =>
  urlOf({ kind: "section", term: term.code, crn })

/** An event's, at its place where the map knows it */
export const eventResolved = (event: Event | Pin, place?: GazetteerPlace): Resolved => {
  const calendar = calendarOf(event)
  return {
    preview: eventPreview(event),
    parts:   [
      place
        ? { heading: "Where", items: [{ text: place.name, href: urlOf({ kind: "place", name: place.name }), ...event.where && event.where !== place.name && { detail: event.where } }] }
        : { heading: "Where", lines: [whereOf(event)] },
      ...("description" in event && event.description ? [{ heading: "About", lines: [event.description] }] : []),
      ...calendar ? [{ heading: "Listed on", items: [{ text: calendar.name, href: event.url }] }] : []
    ],
    event,
    place
  }
}

/** The facts of a chapter's house */
const chapterPart = (name: string): Part[] => {
  const chapter = chapterNamed(name)
  return chapter ? [{
    heading: "Chapter",
    lines:   [[chapter.letters, chapter.kind === "fraternity" ? "Fraternity" : "Sorority", chapter.council].join(" · "), ...chapter.house ? [chapter.house.address] : []],
    items:   [{ text: `${chapter.name} at UNH`, href: chapter.url }]
  }] : []
}

const placeResolved = async (site: Site, name: string, now: number): Promise<Resolved | undefined> => {
  const [{ places }, { events }, { buildings }, terms] = await Promise.all([
    site.named("gazetteer", Gazetteer), site.named("events", EventsData), site.named("places", Places), termsOf(site, entries => activeTerms(entries, now))
  ])
  const place = gazetteerPlaceOf(places, name)
  if (!place)
    return
  const on = events.filter(event => event.place === name && event.end > now).sort((a, b) => a.start - b.start)
  const rooms = new Map<string, { where: string, classes: Set<string> }>()
  for (const term of terms)
    for (const section of term.sections)
      for (const meeting of section.meetings)
        if (meeting.place === name) {
          const room = rooms.get(roomKey(meeting.where)) ?? rooms.set(roomKey(meeting.where), { where: meeting.where, classes: new Set() }).get(roomKey(meeting.where))!
          room.classes.add(courseOf(section))
        }
  const laundry = buildings.filter(building => building.kind === "laundry" && building.name === name).flatMap(({ rooms = [] }) => rooms).flatMap(slug => roomAtSlug(slug) ?? [])
  const isDining = buildings.some(building => building.kind === "dining" && building.name === name)
  return {
    preview: placePreview(place, events, now),
    parts:   [
      ...chapterPart(name),
      on.length
        ? { heading: "What's on", items: on.slice(0, ON_SHOWN).map(event => ({ text: event.title, href: urlOf({ kind: "event", id: event.id }), detail: whenOf(event) })) }
        : { heading: "What's on", lines: ["Nothing listed this week"] },
      ...isDining ? [{ heading: "Dining", items: [{ text: "Holloway & Philbrook menus today", href: "/dining/" }] }] : [],
      ...laundry.length ? [{ heading: "Laundry", items: laundry.map(room => ({ text: `${room.name} laundry room`, href: pathOf(room.id) })) }] : [],
      ...rooms.size ? [{
        heading: "Classrooms",
        items:   [...rooms.values()].sort((a, b) => a.where.localeCompare(b.where, "en", { numeric: true }))
          .map(({ where, classes }) => ({ text: where, href: urlOf({ kind: "room", where }), detail: `${classes.size} ${classes.size === 1 ? "course" : "courses"}` }))
      }] : []
    ],
    place
  }
}

const stopResolved = async (site: Site, id: string, now: number): Promise<Resolved | undefined> => {
  const feed = await site.named("gtfs", FeedData)
  const preview = stopPreview(feed, id)
  if (!preview)
    return
  const routes = new Map(feed.routes.map(route => [route.id, route.name === route.long ? route.name : `${route.name} ${route.long}`]))
  const lines = new Map<string, number[]>()
  for (const { trip, at } of scheduledFrom(feed, feed.stops.findIndex(stop => stop.id === id), now, now + SCHEDULE_HOURS * HOUR)) {
    const route = routes.get(trip.route) ?? trip.route
    const line = trip.headsign && trip.headsign !== route ? `${route} toward ${trip.headsign}` : route
    lines.set(line, [...lines.get(line) ?? [], at])
  }
  const heading = plain(`Next buses by the timetable, from ${clockOf(now)}`)
  return {
    preview,
    parts: [lines.size
      ? { heading, items: [...lines].map(([text, times]) => ({ text, detail: plain(times.slice(0, TIMES_SHOWN).map(clockOf).join(", ")) })) }
      : { heading, lines: [`None in the next ${SCHEDULE_HOURS} hours`] }]
  }
}

/** A page's summary from the site's data at an instant, or none for a page naming nothing there is */
export const resolve = async (site: Site, page: Page, now: number): Promise<Resolved | undefined> => {
  switch (page.kind) {
    case "event": {
      const { events } = await site.named("events", EventsData)
      const event = events.find(({ id }) => id === page.id)
      if (!event)
        return
      const { places } = await site.named("gazetteer", Gazetteer)
      return eventResolved(event, gazetteerPlaceOf(places, event.place))
    }
    case "place":
      return placeResolved(site, page.name, now)
    case "section": {
      const index = await site.named("courses", CoursesIndex)
      const entry = index.terms.find(({ code }) => code === page.term)
      const term = entry && termOf(index, entry, await site.file(entry.file, TermFile))
      const section = term?.sections.find(({ crn }) => crn === page.crn)
      return section && {
        preview: sectionPreview(term!, section),
        parts:   [
          {
            heading: "Meetings",
            items:   section.meetings.map(meeting => ({ text: meetingWhen(meeting), ...meeting.place && { href: urlOf({ kind: "room", where: meeting.where }) }, detail: `${meeting.where}, ${meeting.from} to ${meeting.to}` }))
          },
          { heading: "Course", lines: [`${section.credits} credits`], items: [{ text: `Every section of ${courseOf(section)}`, href: urlOf({ kind: "course", code: courseOf(section) }) }] }
        ]
      }
    }
    case "course": {
      const terms = await termsOf(site, entries => entries)
      const preview = coursePreview(page.code, terms)
      return preview && {
        preview,
        parts: terms.flatMap(term => {
          const sections = term.sections.filter(section => courseOf(section) === page.code)
          return sections.length ? [{
            heading: term.name,
            items:   sections.map(section => ({ text: `${codeOf(section)} ${KINDS[section.kind] ?? section.kind}`, href: sectionUrl(term, section.crn), detail: [weeklyOf(section), roomsOf(section)].filter(Boolean).join(" · ") }))
          }] : []
        })
      }
    }
    case "person": {
      // Only for the link's own preview: an instructor's page is kept out of search, so its body says nothing more
      const person = createPeople(await termsOf(site, entries => activeTerms(entries, now))).find(({ id }) => id === page.id)
      return person && { preview: personPreview(person), parts: [] }
    }
    case "room": {
      const terms = await termsOf(site, entries => activeTerms(entries, now))
      const isRoom = (where: string) => roomKey(where) === roomKey(page.where)
      const preview = roomPreview(page.where, terms, isRoom)
      return preview && {
        preview,
        parts: [{
          heading: "Classes here",
          items:   terms.flatMap(term => term.sections.flatMap(section => section.meetings.filter(meeting => isRoom(meeting.where)).map(meeting => ({
            text:   `${codeOf(section)} ${section.title}`,
            href:   sectionUrl(term, section.crn),
            detail: `${meetingWhen(meeting)}, ${term.name}`
          }))))
        }]
      }
    }
    case "program": {
      const index = await site.named("prereqs", PrereqsIndex)
      const listed = index.programs ? (await site.file(index.programs, Programs)).programs : []
      if (!page.slug)
        return index.programs ? {
          preview: programsPreview(listed.length, index.year ?? ""),
          parts:   [{ heading: "Programs", items: listed.toSorted((a, b) => a.title.localeCompare(b.title, "en")).map(({ slug, title }) => ({ text: title, href: urlOf({ kind: "program", slug }) })) }]
        } : undefined
      const program = listed.find(({ slug }) => slug === page.slug)
      if (!program)
        return
      const { courses, titles, url } = await site.file(program.file, Program)
      return {
        preview: programPreview(program, courses.length, index.year ?? ""),
        parts:   [
          { heading: "Courses", items: courses.map(code => ({ text: titles[code] ? `${code} · ${titles[code]}` : code, href: urlOf({ kind: "course", code }) })) },
          ...url ? [{ heading: "Requirements", items: [{ text: "In the UNH Catalog", href: url }] }] : []
        ]
      }
    }
    case "parking": {
      const [{ places }, { areas }] = await Promise.all([site.named("gazetteer", Gazetteer), site.named("parking", ParkingData)])
      if (page.place && !places.some(({ name }) => name === page.place))
        return
      return {
        preview: parkingPreview(page.place),
        parts:   page.place ? [] : [{ heading: "Lots and meters", items: areas.map(area => ({ text: area.name, href: urlOf({ kind: "area", id: area.id }), ...area.spaces && { detail: `${area.spaces} spaces` } })) }]
      }
    }
    case "area": {
      const area = (await site.named("parking", ParkingData)).areas.find(({ id }) => id === page.id)
      return area && { preview: areaPreview(area), parts: area.permits.length ? [{ heading: "Permits", lines: [area.permits.join(", ")] }] : [] }
    }
    case "stop":
      return stopResolved(site, page.id, now)
    default:
      return
  }
}
