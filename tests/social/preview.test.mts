import { test, expect } from "vitest"
import fc from "fast-check"
import { type Event, type Pin, whereOf } from "../../src/social/event.mts"
import { type Preview, coursePreview, describe, eventPreview, personPreview, placePreview, roomPreview, sectionPreview, stopPreview, whenOf } from "../../src/social/preview.mts"
import type { Section, Term } from "../../src/courses/course.mts"
import { createPeople } from "../../src/courses/people.mts"
import { hide, reveal } from "../../src/courses/email.mts"
import { DAY, HOUR, addDays, dayStart, localDay } from "../../src/shared/time.mts"

// A Wednesday in term, with no clock change for weeks either side, so a time of day is so many hours from midnight
const TODAY = "2026-10-07"

/** A moment some days either side of today, at a time of day */
const momentOf = (days: number, ms: number) =>
  dayStart(addDays(TODAY, days)) + ms

const event = (start: number, end: number, overrides: Partial<Event> = {}): Event =>
  ({ id: "e", title: "Honors Drop In Advising", start, end, place: "Huddleston Hall", where: "Room 201", source: "25live", url: "", ...overrides })

const section = (overrides: Partial<Section> = {}): Section => ({
  crn: "12496", subject: "CS", number: "518", section: "01", title: "Data Structures", kind: "LEC", mode: "IPFF", credits: "4.0",
  from: "2026-08-31", to: "2026-12-14", instructors: [], crossListed: [],
  meetings: [
    { days: "TR", start: 850, end: 930, from: "2026-08-31", to: "2026-12-14", place: "Kingsbury Hall", where: "Kingsbury N343" },
    { days: "F", start: 550, end: 600, from: "2026-08-31", to: "2026-12-14", place: "Kingsbury Hall", where: "Kingsbury N113" }
  ],
  ...overrides
})

const term = (sections: Section[], name = "Fall 2026"): Term =>
  ({ code: "202610", name, from: "2026-08-31", to: "2026-12-14", fetched: 0, built: 0, sections })

// What Intl may put in a time, which every line says as plain spaces
const NARROW = /[  ]/

test("an event says its date, never today or tomorrow, as a preview is shown days after, and its hours as a range on Durham's clock", () =>
  fc.assert(fc.property(fc.integer({ min: -400, max: 400 }), fc.integer({ min: 0, max: DAY - 1 }), fc.integer({ min: -3, max: 30 }), fc.integer({ min: 0, max: 22 * HOUR }), fc.integer({ min: 60_000, max: 12 * HOUR }),
    (days, ms, away, at, length) => {
      const now = momentOf(days, ms)
      const start = dayStart(addDays(localDay(now), away)) + at
      const when = whenOf(event(start, start + length))
      expect(when).not.toMatch(NARROW)
      expect(when.startsWith(`${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(start)}, `)).toBe(true)
      // One range on the day, else from a time on it to a date and time on another
      expect(when).toMatch(localDay(start + length) === localDay(start)
        ? /\d{1,2}:\d\d( [AP]M)? – \d{1,2}:\d\d [AP]M$/
        : /\d{1,2}:\d\d [AP]M – \w{3}, \w{3} \d{1,2} \d{1,2}:\d\d [AP]M$/)
    }
  ))
)

test("an event's preview is its title over when and where, which its description joins, as a link to one says", () => {
  const start = momentOf(0, 13.5 * HOUR)
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(start)
  const preview = eventPreview(event(start, momentOf(0, 14 * HOUR + 40 * 60_000), { where: "" }))
  expect(preview).toEqual({ kind: "Event", title: "Honors Drop In Advising", lines: [`${day} 1:30 – 2:40 PM`, "Huddleston Hall"] })
  expect(describe(preview)).toBe(`${day} 1:30 – 2:40 PM · Huddleston Hall`)
})

test("a pin says how many are going once some are, and that its time's to pick until it's set", () => {
  const now = momentOf(0, 9 * HOUR)
  const pin: Pin = { ...event(now + DAY, now + DAY + HOUR), source: "pin", description: "", visibility: "link", times: [], marks: [], going: 3 }
  expect(eventPreview(pin).lines).toEqual([whenOf(pin), "Huddleston Hall · Room 201", "3 going"])
  expect(eventPreview({ ...pin, going: 0 }).lines).toHaveLength(2)
  const unset = { ...pin, times: [{ start: now, end: now + HOUR }, { start: now + DAY, end: now + DAY + HOUR }], marks: [0, 0], going: 0 }
  expect(eventPreview(unset)).toMatchObject({ kind: "Student event", lines: ["Time to pick", whereOf(pin)] })
})

test("a description is its lines in order, the empty left out, so it never starts, ends or doubles a separator", () =>
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 20 }).filter(line => !line.includes(" · ")), { maxLength: 4 }), lines => {
    const description = describe({ lines })
    expect(description.split(" · ")).toEqual(lines.filter(Boolean).length ? lines.filter(Boolean) : [""])
  }))
)

test("a place's preview names what's on there next, and only there", () => {
  const now = momentOf(0, 9 * HOUR)
  const events = [
    event(now - 3 * HOUR, now - HOUR, { title: "Over" }),
    event(now + 5 * HOUR, now + 6 * HOUR, { title: "Later" }),
    event(now + 2 * HOUR, now + 3 * HOUR, { title: "Sooner" }),
    event(now + HOUR, now + 2 * HOUR, { title: "Elsewhere", place: "Kingsbury Hall" })
  ]
  expect(placePreview({ name: "Huddleston Hall", kind: "building" }, events, now)).toEqual({ kind: "Building", title: "Huddleston Hall", lines: ["Next: Sooner", whenOf(events[2])] })
  expect(placePreview({ name: "Wildcat Stadium", kind: "sports_centre" }, events, now)).toEqual({ kind: "Sports centre", title: "Wildcat Stadium", lines: ["Directions by bus or on foot"] })
})

test("a section says its code, kind and term, when it meets each week, and each room once", () => {
  expect(sectionPreview(term([]), section())).toEqual({
    kind:  "CS 518 (01) · Lecture · Fall 2026",
    title: "Data Structures",
    lines: ["Tue Thu 2:10 – 3:30 PM · Fri 9:10 – 10:00 AM", "Kingsbury N343 · Kingsbury N113"]
  })
  expect(sectionPreview(term([]), section({ meetings: [{ days: "", start: 0, end: 0, from: "2026-08-31", to: "2026-12-14", where: "On-line course" }] })).lines).toEqual(["Arranged", "On-line course"])
})

test("a course counts its sections in each term that offers it, and is nothing where none does", () => {
  const terms = [term([section(), section({ crn: "12497", section: "02" }), section({ crn: "20000", number: "520" })]), term([], "J-Term 2027"), term([section({ crn: "30000" })], "Spring 2027")]
  expect(coursePreview("CS 518", terms)).toEqual({ kind: "Course", title: "CS 518 · Data Structures", lines: ["Fall 2026: 2 sections", "Spring 2027: 1 section"] })
  expect(coursePreview("CS 999", terms)).toBeUndefined()
})

test("an instructor's preview says their name and teaching, never their address, hidden or not", () =>
  fc.assert(fc.property(fc.emailAddress(), fc.string({ minLength: 1, maxLength: 30 }).filter(name => !name.includes("@")), (address, name) => {
    const hidden = hide(address)
    const [person] = createPeople([term([section({ instructors: [{ name, mail: hidden }] })])])
    const said = JSON.stringify(personPreview(person))
    expect(said).not.toContain(hidden)
    expect(said).not.toContain(reveal(hidden))
    expect(said).not.toContain("@")
    expect(personPreview(person)).toEqual({ kind: "Instructor", title: name, lines: ["Teaches CS 518", "Fall 2026"] })
  }))
)

test("a room is named as the registrar writes it, with the courses meeting there, and is nothing where none does", () => {
  const terms = [term([section(), section({ crn: "20000", number: "520" }), section({ crn: "30000", subject: "MATH", number: "425", meetings: [section().meetings[1]] })])]
  const isN343 = (where: string) => where.toUpperCase() === "KINGSBURY N343"
  expect(roomPreview("kingsbury n343", terms, isN343)).toEqual({ kind: "Room · Kingsbury Hall", title: "Kingsbury N343", lines: ["Classes: CS 518, CS 520"] })
  expect(roomPreview("Nowhere 1", terms, () => false)).toBeUndefined()
})

test("a stop names the routes stopping there", () => {
  const feed = {
    stops:  [{ id: "101", name: "McConnell Hall", lat: 0, lon: 0 }, { id: "102", name: "Elsewhere", lat: 0, lon: 0 }],
    routes: [{ id: "3", name: "3", long: "Dover", color: "", text: "" }, { id: "Gables", name: "Gables Connector", long: "Gables Connector", color: "", text: "" }],
    trips:  [{ route: "3", stops: [0, 1] }, { route: "Gables", stops: [1] }] as never
  }
  expect(stopPreview(feed, "101")).toEqual({ kind: "Stop 101", title: "McConnell Hall", lines: ["Buses: 3 Dover"] })
  expect(stopPreview(feed, "102")!.lines).toEqual(["Buses: 3 Dover, Gables Connector"])
  expect(stopPreview(feed, "999")).toBeUndefined()
})

test("every preview has a kind, a title and lines without empty ones", () => {
  const now = momentOf(0, 9 * HOUR)
  const previews: (Preview | undefined)[] = [
    eventPreview(event(now, now + HOUR)), sectionPreview(term([]), section()), coursePreview("CS 518", [term([section()])]),
    placePreview({ name: "T-Hall", kind: "building" }, [], now)
  ]
  for (const preview of previews) {
    expect(preview!.kind && preview!.title).toBeTruthy()
    expect(preview!.lines.every(Boolean)).toBe(true)
  }
})
