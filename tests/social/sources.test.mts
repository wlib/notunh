import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { type Event, Event as EventSchema, EventsData } from "../../src/social/event.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { WEEKS, classificationUrl, classificationsOf, dserecUrl, from25Live, fromAthletics, fromDserec, fromPresence, fromPresenceClubs, fromRecInstances, fromRecOfferings, merged, programOf, programUrl, programsOf } from "../../src/social/sources.mts"
import { addDays, atClock, hhmm, localDay, weekday } from "../../src/shared/time.mts"
import { classDays, fromLive25 } from "../../src/courses/calendar.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { Curated, fromCurated } from "../../src/social/curated.mts"

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
const rawOrganizations = JSON.parse(await fixture("presence-clubs.json")) as { uri: string, regularMeetingTime: string }[]
const program = { id: "8520b0bd-ad58-415b-a070-7dc7c18e06fc", ...programOf(await fixture("rec-program.html")) }
const offerings = fromRecOfferings(await fixture("rec-offerings.html"), program, "Fall 2026", match)
const skate = { id: "af8ff201-7146-4688-b10e-fe79418e3ff2", ...programOf(await fixture("rec-calendar-program.html")) }
const sessions = fromRecInstances(await fixture("rec-instances.html"), skate, match)

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

test("a Presence event written from a weekly meeting's first start to its last end is its first session, at its place", () => {
  // As Wildcat Link listed the Genealogy Club's, 7 to 8 PM on Thursday 5 November 2026, ending a week on
  const [dna] = fromPresence([{
    uri:              "strawberry-dna-extraction-2",
    eventName:        "Strawberry DNA Extraction",
    location:         "MUB 334",
    startDateTimeUtc: "2026-11-06T00:00:00Z",
    endDateTimeUtc:   "2026-11-13T01:00:00Z"
  }], match)
  expect(dna).toMatchObject({ start: Date.parse("2026-11-06T00:00:00Z"), end: Date.parse("2026-11-06T01:00:00Z"), place: "Memorial Union Building", where: "MUB 334" })
  // A day and more, like Ocean Discovery Day, is as written
  expect(presence.find(event => event.title === "Ocean Discovery Day")!.end - presence.find(event => event.title === "Ocean Discovery Day")!.start).toBe(30.5 * 3_600_000)
})

test("a Presence event is kept as written up to two days, and past that is a session of under a day from its start", () =>
  fc.assert(fc.property(fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) }), fc.integer({ min: 1, max: 30 * 24 * 60 }), (start, minutes) => {
    const iso = (ms: number) => new Date(ms).toISOString()
    const end = start + minutes * 60_000
    const [read] = fromPresence([{ uri: "x", eventName: "X", startDateTimeUtc: iso(start), endDateTimeUtc: iso(end) }], match)
    const at = Date.parse(iso(start))
    expect(read.start).toBe(at)
    if (end - start <= 2 * 86_400_000)
      expect(read.end).toBe(Date.parse(iso(end)))
    else {
      expect(read.end).toBeGreaterThan(at)
      expect(read.end - at).toBeLessThanOrEqual(25 * 3_600_000)
    }
  }))
)

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
  const series = fromCurated(v.parse(Curated, JSON.parse(await fixture("curated.json"))), localDay(file.fetched), 7 * WEEKS, match)
  const calendar = fromLive25(JSON.parse(await readFile(new URL("../fixtures/courses/25live.json", import.meta.url), "utf8")), file.fetched)
  const meetings = fromPresenceClubs(rawOrganizations, classDays(calendar, localDay(file.fetched), 7 * WEEKS), match)
  expect(file.events).toEqual(merged([presence, meetings, live, athletics, clubs, offerings, sessions, series], 0))
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

test("Campus Rec's programs are found by classification, those not for going to left out", async () => {
  const classifications = classificationsOf(await fixture("rec-index.html"))
  // Open Skate in; staff training and sport clubs, which DSE Rec tells, out
  expect(classifications).toContain("1a8b85b7-36e2-4d4a-a99d-85dec6cb1eb9")
  expect(classifications).not.toContain("258cf368-8f7a-4385-8317-085744b68c63")
  expect(classifications).not.toContain("2c9a2bff-70c1-4154-85d3-101b06e21279")
  expect(classificationUrl(classifications[0])).toMatch(/^https:\/\/crec\.unh\.edu\/Program\?classificationId=[0-9a-f-]{36}$/)
  expect(programsOf(await fixture("rec-classification.html"))).toEqual(["af8ff201-7146-4688-b10e-fe79418e3ff2", "cd5a6a27-f8d0-4d19-ad8a-d238f4cca2c6", "05c89c79-f426-4ba3-9143-2047a3880a8f"])
  expect(program.byCalendar).toBe(false)
  expect(programOf(await fixture("rec-calendar-program.html"))).toMatchObject({ name: "Open Skate", byCalendar: true })
})

test("a program scheduled by calendar reads as a session each, at the building its room is in", () => {
  expect(sessions.map(({ id }) => id)).toEqual(["rec:651dcb5a-143a-4c26-8a54-6c50c948e079-202611181815", "rec:651dcb5a-143a-4c26-8a54-6c50c948e079-202611221815"])
  expect(sessions[0]).toMatchObject({ title: "Open Skate", start: atClock("2026-11-18", "18:15"), end: atClock("2026-11-18", "19:30"), place: "Whittemore Center Arena", where: "Ice Rink", left: 500, url: programUrl(skate.id) })
  for (const event of sessions)
    expect(() => v.parse(EventSchema, event)).not.toThrow()
})

/** A Fusion calendar appointment as its page writes them, on the local clock */
const appointment = fc.record({
  day:        day,
  clock:      clock,
  minutes:    fc.integer({ min: 15, max: 240 }),
  size:       fc.integer({ min: 1, max: 500 }),
  registered: fc.integer({ min: 0, max: 500 }),
  room:       fc.constantFrom("Studio 1", "Studio 3", "Ice Rink ", "Swasey Indoor Pool", "Somewhere new")
})

test("a program's sessions read as events at their local times with the spots left, none when they're taken", () =>
  fc.assert(fc.property(fc.array(appointment, { maxLength: 8 }), appointments => {
    const local = (ms: number) => `${localDay(ms)}T${hhmm(ms)}:00`
    const json = appointments.map(({ day, clock, minutes, size, registered, room }, i) => ({
      ID:               `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      StartDate:        `${day}T${clock}:00`,
      EndDate:          local(atClock(day, clock) + minutes * 60_000),
      Location:         room,
      ProductName:      "Zumba",
      NumberRegistered: registered,
      ClassSize:        size
    }))
    const html = `<input id="ApptInfo" name="ApptInfo" type="hidden" value="${JSON.stringify(json).replaceAll("\"", "&quot;")}" />`
    const events = fromRecInstances(html, { id: "p", name: "Zumba", description: "" }, match)
    expect(events).toHaveLength(appointments.filter(({ size, registered }) => size > registered).length)
    for (const event of events) {
      const i = Number(event.id.slice("rec:00000000-0000-4000-8000-".length, -13))
      expect(event.left).toBe(appointments[i].size - appointments[i].registered)
      expect(event.start).toBe(atClock(appointments[i].day, appointments[i].clock))
      expect(hhmm(event.end)).toBe(hhmm(event.start + appointments[i].minutes * 60_000))
      if (appointments[i].room.startsWith("Studio"))
        expect(event).toMatchObject({ place: "Hamel Rec Center", where: appointments[i].room })
    }
  })))

test("an offering with no day in its title is read as its schedule's first session, a cancelled one not at all", async () => {
  const course = await fixture("rec-course.html")
  const lifeguard = { id: "6c690d15-ee42-43f7-b14c-88c1693597b7", name: "Full Lifeguard Certification", description: "" }
  expect(fromRecOfferings(course, lifeguard, "Fall 2026", match)).toEqual([expect.objectContaining({
    title: "Full American Red Cross Lifeguard Certification- Blended Learning", start: atClock("2026-11-20", "18:00"), end: atClock("2026-11-20", "20:00"), place: "Field House", where: "Swasey Indoor Pool", left: 4
  })])
  expect(fromRecOfferings(course.replace("<h3 class=\"card-title\">", "<h3 class=\"card-title\">CANCELLED "), lifeguard, "Fall 2026", match)).toEqual([])
})

/** A time of day on a 12-hour clock, as Campus Rec writes one, "10am" or "4:30pm" or "6:00 PM", and as "HH:MM" */
const written = fc.record({ hour: fc.integer({ min: 1, max: 12 }), minute: fc.constantFrom(0, 15, 30, 45), pm: fc.boolean(), style: fc.constantFrom("short", "long") })
  .map(({ hour, minute, pm, style }) => ({
    text:  style === "short" ? `${hour}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${pm ? "pm" : "am"}` : `${hour}:${String(minute).padStart(2, "0")} ${pm ? "PM" : "AM"}`,
    clock: `${String(hour % 12 + (pm ? 12 : 0)).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  }))

/** An offering's card as Campus Rec's page loads it, with spots left */
const card = (title: string) =>
  `<div class="list-wrapper"><div class="offering-card" data-offering-id="00000000-0000-4000-8000-000000000001"><h3 class="card-title">${title}</h3><p>3 Spots available</p></div>`

/** The windows an offering by a title is read as, in fall 2026: one, or none where it isn't an event */
const windowsOf = (title: string) =>
  fromRecOfferings(card(title), program, "Fall 2026", match).map(({ start, end }) => [start, end])

test("an offering's title with bare hours reads its start by its end's meridiem, or the morning before it", () => {
  expect(windowsOf("Sunday 11/8 (9-11am): Hike")).toEqual([[atClock("2026-11-08", "09:00"), atClock("2026-11-08", "11:00")]])
  expect(windowsOf("Sunday 11/8 (11-1pm): Hike")).toEqual([[atClock("2026-11-08", "11:00"), atClock("2026-11-08", "13:00")]])
  expect(windowsOf("Sunday 11/8 (2-4pm): Hike")).toEqual([[atClock("2026-11-08", "14:00"), atClock("2026-11-08", "16:00")]])
  // A program's times aren't guessed: none written with a meridiem is no window
  expect(windowsOf("Sunday 11/8 (10-4:30): Hike")).toEqual([])
  expect(windowsOf("Sunday 11/8 7:30 Departure")).toEqual([])
})

test("an offering's departure alone is an hour long, named for its program; two times, or a day no month has, are no window", () => {
  expect(fromRecOfferings(card("Saturday 9/5 11:30am Departure"), program, "Fall 2026", match)).toEqual([
    expect.objectContaining({ title: program.name, start: atClock("2026-09-05", "11:30"), end: atClock("2026-09-05", "12:30") })
  ])
  expect(windowsOf("Saturday 9/5 9am Departure, back by 5pm")).toEqual([])
  expect(windowsOf("Friday 12/4 (9pm-1am): Late Climb")).toEqual([])
  expect(windowsOf("Monday 11/31 (9-11am): Hike")).toEqual([])
})

test("an offering's title gives its day and window however the times are written, and what it is without who leads it", () =>
  fc.assert(fc.property(day, written, written, fc.constantFrom("-", " - ", "–"), (on, from, to, dash) => {
    const [, month, date] = on.split("-").map(Number)
    const title = `Saturday ${month}/${date} (${from.text}${dash}${to.text}): Hike - Sam and Brady`
    const [start, end] = [atClock(on, from.clock), atClock(on, to.clock)]
    expect(fromRecOfferings(card(title), program, on.slice(0, 4), match)).toEqual(end > start ? [expect.objectContaining({ title: "Hike", start, end, left: 3 })] : [])
  })))

//#region Clubs

/** Two weeks of days from a Monday, all of them class days */
const fortnight = Array.from({ length: 14 }, (_, i) => addDays("2026-11-16", i))

test("a club meeting every week reads as a meeting each day of its weekday, at its time, told by its start alone where it gives no end", () => {
  const meetings = fromPresenceClubs(rawOrganizations, fortnight, match)
  const of = (uri: string) => meetings.filter(({ id }) => id.startsWith(`presence:${uri}/`))
  expect(of("the-socratic-society").map(({ start, end }) => [start, end])).toEqual(["2026-11-20", "2026-11-27"].map(day => [atClock(day, "14:10"), atClock(day, "15:30")]))
  expect(of("the-socratic-society")[0]).toMatchObject({ title: "The Socratic Society meeting", where: "The Freedom Cafe", source: "presence", url: "https://unh.presence.io/organization/the-socratic-society" })
  expect(of("unh-juggling-club")[0]).toMatchObject({ start: atClock("2026-11-16", "19:00"), end: atClock("2026-11-16", "22:00"), place: "Memorial Union Building" })
  expect(of("french-club").map(({ start, end }) => end - start)).toEqual([0, 0])
  expect(of("french-club")[0]).toMatchObject({ start: atClock("2026-11-16", "18:30"), place: "Murkland Hall" })
  // An office's weekday hours, a monthly or every-other-week meeting, and one to be decided aren't weekly meetings
  for (const uri of ["sharpp", "91-3fm-wunh", "babcock-hall-council", "health-science-club"])
    expect(of(uri)).toEqual([])
  for (const meeting of meetings)
    expect(() => v.parse(EventSchema, meeting)).not.toThrow()
})

test("clubs meet only on the days given, on their own weekdays, each meeting once", () =>
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 60 }), { maxLength: 30 }), offsets => {
    const days = offsets.map(i => addDays("2026-11-16", i))
    const meetings = fromPresenceClubs(rawOrganizations, days, match)
    expect(new Set(meetings.map(({ id }) => id)).size).toBe(meetings.length)
    for (const meeting of meetings)
      expect(days).toContain(localDay(meeting.start))
    expect(meetings.filter(({ id }) => id.startsWith("presence:the-socratic-society/")).every(({ start }) => weekday(localDay(start)) === 4)).toBe(true)
  })))

test("classes meet within a term that's begun, before its last day where one's named, and not on a day without classes", () =>
  fc.assert(fc.property(day, fc.integer({ min: 0, max: 120 }), fc.option(fc.integer({ min: 0, max: 120 })), fc.uniqueArray(fc.integer({ min: 0, max: 60 })), (start, length, after, off) => {
    const noClass = off.map(i => addDays(start, i))
    const end = after === null ? undefined : addDays(start, after)
    const calendar = { noClass, terms: { "202610": { name: "Fall", start, ...end && { end }, reading: [] } } }
    const days = classDays(calendar, addDays(start, -10), length + 20)
    for (const one of days)
      expect(one >= start && (!end || one <= end) && !noClass.includes(one)).toBe(true)
    expect(days.length).toBe(Array.from({ length: length + 20 }, (_, i) => addDays(start, i - 10)).filter(one => one >= start && (!end || one <= end) && !noClass.includes(one)).length)
  })))

//#endregion
