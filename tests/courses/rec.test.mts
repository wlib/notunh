// Campus Rec's schedule (src/courses/rec.mts): its facilities as spaces on the map, and its appointments' occurrences,
// expanded from rules as DevExtreme writes them, on Durham's clock, then kept to the days asked about

import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { CAMPUS_REC, facilitiesFrom, occurrencesOf, recBookingsFrom } from "../../src/courses/rec.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { type Day, addDays, atClock, clockOf, dayStart, localDay, weekday } from "../../src/shared/time.mts"

const fixture = (name: string) => readFile(new URL(`../fixtures/rec/${name}`, import.meta.url), "utf8")
const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const match = placeMatcher(gazetteer.places.map(place => place.name))
const facilities = facilitiesFrom(await fixture("schedule.html"), match)

/** The day the fixtures' schedules were asked about */
const DAY: Day = "2026-10-28"
const WEST_GYM = "d949aebc-c63a-4440-bb87-beda6b2ce438"
const COURT_1 = "b78ab042-f000-4b3a-b36a-1a147cbc5ad6"
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

/** An appointment as Fusion answers one */
const appointment = (start: string, end: string, rule?: string, exceptions?: string) =>
  ({ Text: "Open Gym", StartDate: `${start}:00.000`, EndDate: `${end}:00.000`, AllDay: false, RecurrenceRule: rule ?? null, RecurrenceException: exceptions ?? null })

/** Occurrences as the day and times on Durham's clock they're at */
const said = (occurrences: { start: number, end: number }[]) =>
  occurrences.map(({ start, end }) => `${localDay(start)} ${clockOf(start)}–${clockOf(end)}`)

test("the facilities kept are those the gazetteer places: Hamel's rooms and courts, the fields and pools, each court within its gym", () => {
  const facility = (id: string) => facilities.find(facility => facility.id === id)
  expect(facility(COURT_1)).toEqual({ id: COURT_1, source: "rec", where: "Hamel Rec Center Court 1 (3rd Floor)", place: "Hamel Rec Center", room: "Court 1 (3rd Floor)", isStudy: false, within: WEST_GYM })
  expect(facility(WEST_GYM)).toMatchObject({ room: "3rd Floor (West Gym)" })
  expect(facility(WEST_GYM)?.within).toBeUndefined()
  expect(facilities.find(facility => facility.place === "Bremner Field")).toMatchObject({ where: "Bremner Field", room: "" })
  expect(facilities.find(facility => facility.room === "Swasey Indoor Pool")?.place).toBe("Field House")
  // Nowhere the gazetteer names: the tennis courts, Boulder Field, Mendums Pond
  expect(facilities.some(facility => /Tennis|Boulder Field|Mendums/.test(facility.where))).toBe(false)
  expect(new Set(facilities.map(facility => facility.where)).size).toBe(facilities.length)
})

test("a rule's occurrences are those it makes from its first, till its UNTIL or COUNT, but its exceptions", () => {
  // UNTIL is UTC: 4:30 PM there is 12:30 PM in Durham, the last morning's end
  expect(said(occurrencesOf(appointment("2027-08-02T07:30", "2027-08-02T12:30", "FREQ=DAILY;UNTIL=20270806T163000Z"), "2027-07-01", "2027-08-31")))
    .toEqual(["02", "03", "04", "05", "06"].map(date => `2027-08-${date} 7:30 AM–12:30 PM`))
  expect(said(occurrencesOf(appointment("2026-10-05T18:00", "2026-10-05T19:00", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU"), "2026-10-01", "2026-11-10")))
    .toEqual(["2026-10-05", "2026-10-19", "2026-11-02"].map(day => `${day} 6:00 PM–7:00 PM`))
  expect(said(occurrencesOf(appointment("2026-10-09T12:00", "2026-10-09T13:00", "FREQ=MONTHLY;INTERVAL=3;BYDAY=FR;BYSETPOS=2"), "2026-10-01", "2027-05-01")))
    .toEqual(["2026-10-09", "2027-01-08", "2027-04-09"].map(day => `${day} 12:00 PM–1:00 PM`))
  expect(occurrencesOf(appointment("2026-10-26T08:00", "2026-10-26T09:00", "FREQ=DAILY;COUNT=4"), "2026-10-01", "2026-11-30")).toHaveLength(4)
  // A first date the rule doesn't fall on isn't one, as DevExtreme shows it: a Wednesday, for Fridays
  expect(said(occurrencesOf(appointment("2026-10-28T08:00", "2026-10-28T09:00", "FREQ=WEEKLY;COUNT=2;BYDAY=FR;WKST=SU"), "2026-10-01", "2026-11-30")))
    .toEqual(["2026-10-30 8:00 AM–9:00 AM", "2026-11-06 8:00 AM–9:00 AM"])
  expect(said(occurrencesOf(appointment("2026-10-26T08:00", "2026-10-26T09:00", "FREQ=WEEKLY;UNTIL=20261031T000000Z;BYDAY=MO,WE,FR;WKST=SU", "20261028T080000"), "2026-10-01", "2026-11-30")))
    .toEqual(["2026-10-26 8:00 AM–9:00 AM", "2026-10-30 8:00 AM–9:00 AM"])
  // A rule set years ago still makes this week's, at its time on the clock of whichever season; one never repeated is only its day's
  expect(said(occurrencesOf(appointment("2021-10-08T10:00", "2021-10-08T11:30", "FREQ=WEEKLY;BYDAY=FR;WKST=SU"), DAY, addDays(DAY, 6)))).toEqual(["2026-10-30 10:00 AM–11:30 AM"])
  expect(occurrencesOf(appointment("2021-10-08T10:00", "2021-10-08T11:30"), DAY, addDays(DAY, 6))).toEqual([])
})

test("whatever a weekly rule, its occurrences fall on its days at its time within the days asked, the same as expanding wider and keeping those days", () => {
  const rule = fc.record({
    back:     fc.integer({ min: 0, max: 900 }),
    days:     fc.subarray(WEEKDAYS, { minLength: 1 }),
    interval: fc.integer({ min: 1, max: 3 }),
    hour:     fc.integer({ min: 6, max: 21 }),
    from:     fc.integer({ min: 0, max: 20 }),
    length:   fc.integer({ min: 0, max: 20 })
  })
  fc.assert(fc.property(rule, ({ back, days, interval, hour, from, length }) => {
    const first = addDays(DAY, -back)
    const time = `${String(hour).padStart(2, "0")}:00`
    const made = appointment(`${first}T${time}`, `${first}T${String(hour + 1).padStart(2, "0")}:00`, `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${days.join(",")};WKST=SU`)
    const [start, end] = [addDays(DAY, from), addDays(DAY, from + length)]
    const found = occurrencesOf(made, start, end)
    for (const occurrence of found) {
      expect(occurrence.start).toBeGreaterThanOrEqual(dayStart(start))
      expect(occurrence.start).toBeLessThan(dayStart(addDays(end, 1)))
      expect(days).toContain(WEEKDAYS[weekday(localDay(occurrence.start))])
      expect(occurrence.start).toBe(atClock(localDay(occurrence.start), time))
    }
    const wider = occurrencesOf(made, addDays(start, -10), addDays(end, 10)).filter(occurrence => occurrence.start >= dayStart(start) && occurrence.start < dayStart(addDays(end, 1)))
    expect(found).toEqual(wider)
  }), { numRuns: 300 })
})

test("a facility's schedule reads into its bookings on the days asked, what's on as their kind, by Campus Rec, however far back its rules were set", async () => {
  const bookings = recBookingsFrom(JSON.parse(await fixture("westgym.json")), WEST_GYM, DAY, DAY)
  expect(bookings.length).toBeGreaterThan(0)
  expect(bookings.every(booking => booking.space === WEST_GYM && booking.org === CAMPUS_REC && booking.title === undefined && localDay(booking.start) === DAY)).toBe(true)
  expect(said(bookings.filter(booking => booking.type === "Intramural Volleyball"))).toEqual(["2026-10-28 7:00 PM–10:30 PM"])
  const all = JSON.parse(await fixture("all.json")) as { StartDate: string }[]
  expect(all.some(made => made.StartDate < "2022")).toBe(true)
  expect(recBookingsFrom(all, "any", DAY, DAY).every(booking => localDay(booking.start) <= DAY && localDay(booking.end - 1) >= DAY)).toBe(true)
})
