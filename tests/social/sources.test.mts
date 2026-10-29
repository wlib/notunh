import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { type Event, Event as EventSchema, EventsData } from "../../src/social/event.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { dserecUrl, from25Live, fromAthletics, fromDserec, fromPresence, fromRecOfferings, merged, programOf, programUrl, REC_PROGRAMS } from "../../src/social/sources.mts"
import { addDays, atClock } from "../../src/shared/time.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"

const fixture = (name: string) => readFile(new URL(`../fixtures/events/${name}`, import.meta.url), "utf8")
const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const match = placeMatcher(gazetteer.places.map(place => place.name))

const rawPresence = JSON.parse(await fixture("presence.json")) as { uri: string, isVirtualEventLink?: boolean }[]
const rawLive = JSON.parse(await fixture("25live.json")) as unknown[]
const presence = fromPresence(rawPresence, match)
const live = from25Live(rawLive, match)
const athletics = fromAthletics(await fixture("athletics.ics"), match)
const rawClubs = JSON.parse(await fixture("dserec.json")) as { data: DserecRow[] }
const clubs = fromDserec(rawClubs, match)
const program = { id: REC_PROGRAMS[3], ...programOf(await fixture("rec-program.html")) }
const offerings = fromRecOfferings(await fixture("rec-offerings.html"), program, "Fall 2026", match)

test("each calendar's answer reads into events of the one shape, each a window at a place where the text names one", () => {
  for (const event of [...presence, ...live, ...athletics, ...clubs]) {
    expect(() => v.parse(EventSchema, event)).not.toThrow()
    expect(event.end).toBeGreaterThanOrEqual(event.start)
    expect(event.title).not.toMatch(/<|&amp;|\s{2}/)
  }
  expect(presence[0]).toMatchObject({ id: "presence:take-back-the-night-4", title: "Take Back The Night", place: "Thompson Hall Lawn", where: "Thompson Hall Lawn", source: "presence", url: "https://unh.presence.io/event/take-back-the-night-4" })
  expect(presence[0].start).toBe(Date.parse("2026-10-16T00:00:11Z"))
  expect(live.find(event => event.id === "25live:1458177342")).toMatchObject({ title: "LGBTQIA+ Resource Fair & Kidder Lecture", place: "Memorial Union Building", where: "Memorial Union Building 237 (MUB)", source: "25live" })
  expect(athletics[0]).toMatchObject({ source: "athletics", where: "Lundholm Gymnasium", place: "Field House" })
  expect(athletics[0].title).toMatch(/^UNH Women's Volleyball vs/)
  expect(athletics[0].url).not.toContain("&amp;")
  expect(athletics.find(event => event.where.startsWith("Whittemore"))).toMatchObject({ place: "Whittemore Center Arena" })
})

test("what isn't an event to go to is left out: online, cancelled, postponed, training, deadlines, Manchester, and away games", () => {
  expect(rawLive.length).toBeGreaterThan(live.length)
  expect(live.some(event => /Online/.test(event.where))).toBe(false)
  expect(live.some(event => event.where.startsWith("UNHM"))).toBe(false)
  expect(presence).toHaveLength(rawPresence.length)
  expect(fromPresence([{ ...rawPresence[0], isVirtualEventLink: true }], match)).toEqual([])
  expect(athletics).toHaveLength(9)
  expect(athletics.some(event => /POSTPONED/.test(event.title))).toBe(false)
  expect(athletics.every(event => ["Field House", "Whittemore Center Arena", "Wildcat Stadium", "Memorial Field"].includes(event.place!))).toBe(true)
})

test("25Live's local times are read with the offsets beside them", () => {
  const event = live.find(event => event.id === "25live:1458177342")!
  expect(new Date(event.start).toISOString()).toBe("2026-10-26T16:00:00.000Z")
})

test("a calendar-only 25Live entry is placed by its description", () => {
  const placed = from25Live([{ eventID: 1, title: "Talk", description: "<p>Stop by Conant Hall 102 at noon</p>", location: "Calendar Only Event", startDateTime: "2026-10-27T12:00:00", endDateTime: "2026-10-27T13:00:00", startTimeZoneOffset: "-0400", endTimeZoneOffset: "-0400", categoryCalendar: "University of New Hampshire Events|Lectures & Talks" }], match)
  expect(placed).toHaveLength(1)
  expect(placed[0]).toMatchObject({ place: "Conant Hall", where: "" })
})

test("an entry of a shape not known is left out rather than failing the rest", () => {
  expect(fromPresence([{ uri: "ok", eventName: "Ok", startDateTimeUtc: "2026-10-27T12:00:00Z", endDateTimeUtc: "2026-10-27T13:00:00Z" }, { eventName: "No uri" }, null, 3], match)).toHaveLength(1)
  expect(() => from25Live("not even a list", match)).toThrow()
  expect(fromAthletics("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:No times\nLOCATION:Durham\\, N.H.\\, Wildcat Stadium\nEND:VEVENT\nEND:VCALENDAR", match)).toEqual([])
})

const event = (overrides: Partial<Event> = {}): Event =>
  ({ id: "x", title: "T", start: 0, end: 1, where: "", source: "pin", url: "", ...overrides })

test("merging keeps each id once, in order of start, dropping what ended before the cut and anything ending before it starts", () =>
  fc.assert(fc.property(
    fc.array(fc.record({ id: fc.constantFrom("a", "b", "c", "d", "e"), start: fc.integer({ min: 0, max: 100 }), length: fc.integer({ min: -5, max: 50 }) }), { maxLength: 20 }),
    fc.integer({ min: 0, max: 100 }),
    (items, from) => {
      const lists = [items.slice(0, items.length >> 1), items.slice(items.length >> 1)].map(list => list.map(({ id, start, length }) => event({ id, start, end: start + length })))
      const out = merged(lists, from)
      const ids = out.map(({ id }) => id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const [i, item] of out.entries()) {
        expect(item.end).toBeGreaterThanOrEqual(from)
        expect(item.end).toBeGreaterThanOrEqual(item.start)
        if (i)
          expect(item.start).toBeGreaterThanOrEqual(out[i - 1].start)
      }
      // The first fit occurrence of each id is the one kept
      for (const item of out)
        expect(lists.flat().find(({ id, end, start }) => id === item.id && end >= from && start <= end)).toEqual(item)
    }
  ))
)

test("the fixture's events file is what the build would make of the fixtures, and reads as events data", async () => {
  const file = v.parse(EventsData, JSON.parse(await readFile(new URL("../fixtures/data/src/map/events.json", import.meta.url), "utf8")))
  expect(file.events).toEqual(merged([presence, live, athletics, clubs, offerings], 0))
})

//#region DSE Rec

/** A row of DSE Rec's events as its JSON has them, those fields read */
type DserecRow = {
  id:                     number
  name:                   string
  club_id:                number
  club_name:              string
  type:                   string
  field:                  string
  location:               string
  calculated_start:       string
  calculated_end:         string
  calculated_status:      string
  home_events_off_campus: number
}

const row = (overrides: Partial<DserecRow> = {}): DserecRow =>
  ({ id: 1, name: "Practice", club_id: 22, club_name: "Tennis", type: "practice", field: "Bremner Field", location: "collage", calculated_start: "2026-10-26 17:15:00", calculated_end: "2026-10-26 19:15:00", calculated_status: "event_pending", home_events_off_campus: 0, ...overrides })

const clubsOf = (rows: DserecRow[]) =>
  fromDserec({ data: rows }, match)

test("sport clubs' home events read with the club and type in the title, at the field they name, linking to the club", () => {
  expect(clubs.find(event => event.id === "dserec:5970")).toMatchObject({ title: "Women’s Lacrosse game: UNHWCL Play Day", place: "Bremner Field", where: "Bremner Field", source: "dserec", url: "https://unh.dserec.com/online/clubsports/club/12/events" })
  expect(clubs.find(event => event.id === "dserec:6052")).toMatchObject({ title: "Women's Rugby game: University of Vermont", place: "Student Rec Field" })
  expect(clubs.find(event => event.id === "dserec:6544")).toMatchObject({ place: "Hamel Rec Center", where: "3rd Floor UNH HRC" })
  expect(clubs.find(event => event.id === "dserec:6476")).toMatchObject({ title: "Woodsmen tournament: Home Meet", place: "UNH Thompson School Sawmill" })
  expect(clubs.find(event => event.id === "dserec:6296")).toMatchObject({ title: "Tennis: Practice", where: "UNH Tennis Courts" })
  // Durham's clock, an hour later in UTC once the clocks go back
  expect(new Date(clubs.find(event => event.id === "dserec:5970")!.start).toISOString()).toBe("2026-10-25T13:00:00.000Z")
})

test("away games, home events held off campus, and the cancelled are left out, as pending events are kept", () => {
  const ids = new Set(clubs.map(({ id }) => id))
  for (const away of rawClubs.data.filter(event => event.location !== "collage" || event.home_events_off_campus))
    expect(ids.has(`dserec:${away.id}`)).toBe(false)
  expect(clubs.length).toBeGreaterThan(0)
  expect(clubsOf([row({ calculated_status: "event_cancelled" })])).toEqual([])
  expect(clubsOf([row({ calculated_status: "event_pending" }), row({ id: 2, calculated_start: "2026-10-27 17:15:00", calculated_end: "2026-10-27 19:15:00", calculated_status: "event_approved" })])).toHaveLength(2)
})

test("a series written as its first session's start and its last day's end reads as that one session", () => {
  const series = rawClubs.data.find(event => event.id === 6238)!
  expect(series.calculated_end.slice(0, 10)).not.toBe(series.calculated_start.slice(0, 10))
  expect(clubs.find(event => event.id === "dserec:6238")).toMatchObject({ start: atClock("2026-10-05", "17:15"), end: atClock("2026-10-05", "19:15") })
  // A home regatta over two evenings reads as its first
  expect(clubs.find(event => event.id === "dserec:6149")).toMatchObject({ start: atClock("2026-10-24", "18:30"), end: atClock("2026-10-24", "20:30") })
  // An end earlier on the clock than the start is the next day's, as at midnight
  expect(clubsOf([row({ calculated_start: "2026-11-07 21:00:00", calculated_end: "2026-11-09 00:00:00" })])[0]).toMatchObject({ start: atClock("2026-11-07", "21:00"), end: atClock("2026-11-08", "00:00") })
})

test("a practice listed as its session and as a series starting then is kept once, as the session", () => {
  const pair = rawClubs.data.filter(event => event.id === 6250 || event.id === 6296)
  expect(pair).toHaveLength(2)
  expect(clubs.filter(event => event.id === "dserec:6250" || event.id === "dserec:6296").map(({ id }) => id)).toEqual(["dserec:6296"])
})

/** A Durham day within a year of the fixtures' and a time on the clock, as DSE Rec writes them */
const day = fc.integer({ min: -180, max: 180 }).map(offset => addDays("2026-10-24", offset))
const clock = fc.record({ hour: fc.integer({ min: 0, max: 23 }), minute: fc.constantFrom(0, 15, 30, 45) })
  .map(({ hour, minute }) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`)

test("any session, written whole or as a series of any length beside it, reads as one window under a day long from its start", () =>
  fc.assert(fc.property(day, clock, clock, fc.integer({ min: 0, max: 120 }), fc.boolean(), (start, from, to, days, alsoSeries) => {
    // A session ends after it starts, or on a later day
    fc.pre(days > 0 || to > from)
    const rows = [row({ calculated_start: `${start} ${from}:00`, calculated_end: `${addDays(start, days)} ${to}:00` })]
    if (alsoSeries)
      rows.push(row({ id: 2, calculated_start: `${start} ${from}:00`, calculated_end: `${addDays(start, days + 77)} ${to}:00` }))
    const out = clubsOf(rows)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("dserec:1")
    expect(out[0].start).toBe(atClock(start, from))
    expect(out[0].end).toBeGreaterThan(out[0].start)
    expect(out[0].end).toBe(to > from ? atClock(start, to) : atClock(addDays(start, 1), to))
  }))
)

test("the clubs' events are asked for over Durham days, as DSE Rec's own pages ask", () => {
  const url = new URL(dserecUrl("2026-10-24", "2026-11-13"))
  expect(url.origin + url.pathname).toBe("https://unh.dserec.com/api/clubsports/online/events/list")
  expect(url.searchParams.get("filter[0]")).toBe("date:10/24/2026,11/13/2026")
  expect(url.searchParams.get("order[0]")).toBe("calculated_start:asc")
})

//#endregion

test("Campus Rec's offerings with spots left read as events on their day, in their semester's year, placed where the program meets", async () => {
  expect(program.name).toBe("Night Skiing Trips")
  expect(program.semesters).toEqual([{ id: "5b063ec2-be1d-448d-af9a-4c60d6a4d686", name: "Fall 2026" }])
  const events = offerings
  expect(events.map(({ title, left }) => [title, left])).toEqual([
    ["Honors students: Pancakes on Mt. Major", 2],
    ["Canoeing at Mendums Pond", 8],
    ["Stratham Hill Fire Tower Hike", 9]
  ])
  const [pancakes] = events
  expect(pancakes).toMatchObject({ id: "rec:c1837821-0e05-4cb6-a777-b0e87cfafacc", source: "rec", place: "Hamel Rec Center", url: programUrl(program.id) })
  expect([pancakes.start, pancakes.end]).toEqual([atClock("2026-11-07", "10:00"), atClock("2026-11-07", "16:30")])
  expect(pancakes.closes).toBe(atClock("2026-11-04", "00:00"))
  // Who leads a trip isn't what it is
  expect(events.some(event => /Alex|Sam|Robin|Jordan/.test(event.title))).toBe(false)
  for (const event of events)
    expect(() => v.parse(EventSchema, event)).not.toThrow()
  // None left is none to sign up for
  expect(fromRecOfferings((await fixture("rec-offerings.html")).replace(/\d+ Spots available/g, "0 Spots available"), program, "Fall 2026", match)).toEqual([])
})
