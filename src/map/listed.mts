// Every page of the map worth a search engine's while, for the sitemap (scripts/search.mts): the official events not
// over, the places with something on, classes, a laundry room, a dining hall or a chapter, every stop a bus picks up
// at, the courses, sections and rooms of the terms not over, the programs, and parking. Never an instructor's, which
// are people (UNLISTED in site.mts). Each is of something as of the instant, so resolves

import type { Page } from "./link.mts"
import { type Site, notOver, termsOf } from "./site.mts"
import { EventsData } from "../social/event.mts"
import { Gazetteer } from "../places/gazetteer.mts"
import { Places } from "../places/buildings.mts"
import { CHAPTERS, isPlaced } from "../places/chapters.mts"
import { activeTerms, courseOf } from "../courses/course.mts"
import { roomKey } from "../courses/rooms.mts"
import { PrereqsIndex } from "../programs/prereqs.mts"
import { Programs } from "../programs/program.mts"
import { ParkingData } from "../parking/sources.mts"
import { FeedData, boardableStops } from "../transit/feed.mts"

export const listedPages = async (site: Site, now: number): Promise<Page[]> => {
  const [{ events }, { places }, { buildings }, feed, prereqs, { areas }, terms] = await Promise.all([
    site.named("events", EventsData), site.named("gazetteer", Gazetteer), site.named("places", Places), site.named("gtfs", FeedData),
    site.named("prereqs", PrereqsIndex), site.named("parking", ParkingData), termsOf(site, notOver(now))
  ])
  const active = new Set(activeTerms(terms, now))
  const upcoming = events.filter(event => event.end > now)
  const named = new Set(places.map(({ name }) => name))
  const meetings = [...active].flatMap(term => term.sections.flatMap(section => section.meetings))
  const useful = new Set([
    ...upcoming.map(event => event.place),
    ...meetings.map(meeting => meeting.place),
    ...buildings.map(building => building.name),
    ...CHAPTERS.filter(isPlaced).map(chapter => chapter.name)
  ].filter(name => name !== undefined && named.has(name)) as string[])
  const rooms = new Map(meetings.filter(meeting => meeting.place).map(meeting => [roomKey(meeting.where), meeting.where]))
  const programs = prereqs.programs ? (await site.file(prereqs.programs, Programs)).programs : []
  const stops = boardableStops(feed)
  return [
    ...upcoming.map(({ id }): Page => ({ kind: "event", id })),
    ...[...useful].map((name): Page => ({ kind: "place", name })),
    ...feed.stops.filter((_, index) => stops.has(index)).map(({ id }): Page => ({ kind: "stop", id })),
    ...[...new Set(terms.flatMap(term => term.sections.map(courseOf)))].map((code): Page => ({ kind: "course", code })),
    ...terms.flatMap(term => term.sections.map(({ crn }): Page => ({ kind: "section", term: term.code, crn }))),
    ...[...rooms.values()].map((where): Page => ({ kind: "room", where })),
    ...prereqs.programs ? [{ kind: "program" } as Page] : [],
    ...programs.map(({ slug }): Page => ({ kind: "program", slug })),
    { kind: "parking" },
    ...areas.map(({ id }): Page => ({ kind: "area", id }))
  ]
}
