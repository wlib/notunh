// Reading 25Live's spaces and reservations (src/courses/bookings.mts): which spaces are rooms on the map, what's kept
// of a booking and what never is, who's told a title, how answers merge whatever order they come in, and when a room
// stands free

import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { type Booked, type Booking, type Known, STUDY_GROUP, UNKNOWN, bookingsFrom, bookingsOf, fetchedOf, isAskable, isFreeFor, isPersonal, joined, learned, reservationsUrl, shownTo, spacesFrom, standingAt, weekFrom } from "../../src/courses/bookings.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { addDays, atClock } from "../../src/shared/time.mts"

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/rooms/${name}`, import.meta.url), "utf8"))
const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const match = placeMatcher(gazetteer.places.map(place => place.name))

/** The day the fixtures' reservations are on */
const DAY = "2026-10-28"
const at = (time: string) => atClock(DAY, time)

const rawSpaces = await fixture("spaces.json")
const rawReservations = await fixture("reservations.json")
const spaces = spacesFrom(rawSpaces, match)
const bookings = bookingsFrom(rawReservations)
const [aReservation] = rawReservations.space_reservations.space_reservation.filter((reservation: { event: { event_name: string } }) => reservation.event.event_name !== "(Private)")

test("the spaces kept are rooms on the Durham campus, placed on the gazetteer, with what they're called and hold", () => {
  expect(spaces.find(space => space.id === "532")).toEqual({ id: "532", source: "25live", where: "Dimond Library 121", place: "Dimond Library", room: "121", name: "Collaboration Space", capacity: 5, isStudy: true })
  expect(spaces.find(space => space.id === "496")).toMatchObject({ where: "Memorial Union Building 240", name: "Strafford Room", capacity: 450, isStudy: false })
  expect(spaces.find(space => space.id === "538")).toMatchObject({ where: "Dimond Library 221A", room: "221A" })
  // A lounge 25Live counts as one holds however many it does
  expect(spaces.find(space => space.id === "491")?.capacity).toBeUndefined()
  // Manchester, the law school, info tables and lactation rooms aren't rooms to book on the map
  expect(spaces.some(space => /UNHM|Law|Info|Lactation/.test(`${space.where} ${space.name}`))).toBe(false)
  expect(new Set(spaces.map(space => space.where)).size).toBe(spaces.length)
  // 25Live answers one item bare
  expect(spacesFrom({ spaces: { space: rawSpaces.spaces.space.find((space: { space_id: number }) => space.space_id === 532) } }, match)).toHaveLength(1)
})

test("a booking keeps its space, times, kind, title and organization, never who booked; classes, cancellations and times without an offset are left out", () => {
  expect(JSON.stringify(bookings)).not.toMatch(/abc\d{4}|\(Private\)/)
  expect(bookings.length).toBeLessThan(rawReservations.space_reservations.space_reservation.length)
  expect(bookings).toContainEqual(expect.objectContaining({ space: "127", type: "Meeting", title: "Meeting 23", org: "Tau Kappa Epsilon" }))
  const one = (reservation: object) => bookingsFrom({ space_reservations: { space_reservation: reservation } })
  expect(one(aReservation)).toHaveLength(1)
  expect(one({ ...aReservation, reservation_state: 99 })).toEqual([])
  expect(one({ ...aReservation, reservation_start_dt: aReservation.reservation_start_dt.slice(0, 19) })).toEqual([])
  expect(bookingsFrom({ space_reservations: { engine: "accl" } })).toEqual([])
  expect(reservationsUrl(DAY, ["532", "533"])).toBe("https://25live.collegenet.com/25live/data/unh/run/rm_reservations.json?space_id=532+533&start_dt=20261028&end_dt=20261028")
})

/** A reservation as 25Live answers one, by whoever, called whatever, of whatever kind and organization */
const reservation = fc.record({
  space:  fc.integer({ min: 1, max: 2000 }),
  start:  fc.integer({ min: 0, max: 22 * 60 }),
  length: fc.integer({ min: 15, max: 120 }),
  netid:  fc.stringMatching(/^[a-z]{2,4}\d{1,4}$/),
  title:  fc.oneof(fc.constant("(Private)"), fc.stringMatching(/^[A-Z][a-z]{3,10}( [a-z]{3,10}){0,3}$/)),
  type:   fc.constantFrom(STUDY_GROUP, "Meeting", "Exam", ""),
  org:    fc.constantFrom("", "Durham - Student", "Law-Student", "Theta Chi", "ET&S-Enterprise Technology and Services")
}).map(({ space, start, length, netid, title, type, org }) => ({
  reservation_start_dt: new Date(at("00:00") + start * 60_000).toISOString(),
  reservation_end_dt:   new Date(at("00:00") + (start + length) * 60_000).toISOString(),
  reservation_state:    1,
  last_mod_user:        netid,
  spaces:               { space_id: space, space_name: `057 ${space}` },
  event:                { event_name: title, event_type_name: type, organization_name: org, profile_name: netid }
}))

test("unverified, nobody is told a title; nobody at all is told who booked or an organization that may be a person; and either way every booking is said", () => {
  fc.assert(fc.property(fc.array(reservation, { maxLength: 30 }), reservations => {
    const read = bookingsFrom({ space_reservations: { space_reservation: reservations } })
    const unverified = JSON.stringify(shownTo(read, false))
    const verified = JSON.stringify(shownTo(read, true))
    for (const { last_mod_user, event } of reservations) {
      expect(unverified + verified).not.toContain(`"${last_mod_user}"`)
      if (event.event_name !== "(Private)")
        expect(unverified).not.toContain(`"${event.event_name}"`)
    }
    expect(read.every(booking => booking.org === undefined || !isPersonal(booking))).toBe(true)
    expect(shownTo(read, false).every(booking => booking.title === undefined)).toBe(true)
    expect(shownTo(read, true)).toEqual(read)
    expect(shownTo(read, false).map(({ space, start, end, type }) => ({ space, start, end, type }))).toEqual(read.map(({ space, start, end, type }) => ({ space, start, end, type })))
  }))
})

test("the build's snapshot, which anyone can fetch, has no titles, and no organization that may be a person", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../fixtures/data/src/map/rooms.json", import.meta.url), "utf8"))
  for (const { bookings } of snapshot.days)
    expect(bookings.every((booking: Booking) => booking.title === undefined && !(booking.org !== undefined && isPersonal(booking)))).toBe(true)
})

/** What's known as bookings by space, in order, to compare however they were merged */
const bySpace = (known: Known) =>
  Object.fromEntries([...Map.groupBy(known.bookings, booking => booking.space)].map(([space, bookings]) => [space, bookings.toSorted((a, b) => a.start - b.start || a.end - b.end)]))

const SPACES = ["a", "b", "c"]
/** Answers at distinct times, each covering some spaces (25Live's day, one room, or Campus Rec's facilities) with bookings of those alone */
const answers = fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 6 }).chain(times =>
  fc.tuple(...times.map(fetched => fc.record({
    covers:   fc.subarray(SPACES, { minLength: 1 }),
    bookings: fc.array(fc.record({ space: fc.constantFrom(...SPACES), start: fc.integer({ min: 0, max: 100 }), length: fc.integer({ min: 1, max: 10 }) }), { maxLength: 6 })
  }).map(({ covers, bookings }) => ({
    covers,
    booked: { day: DAY, fetched, bookings: bookings.filter(booking => covers.includes(booking.space)).map(({ space, start, length }): Booking => ({ space, start, end: start + length, type: "Meeting" })) } satisfies Booked
  })))))

test("answers merge to the same whatever order they come in, each space as the newest answer covering it says", () => {
  fc.assert(fc.property(answers, fc.nat(), (all, seed) => {
    const shuffled = all.toSorted((a, b) => (a.booked.fetched * 7919 + seed) % 1009 - (b.booked.fetched * 7919 + seed) % 1009)
    const inOrder = all.reduce((known, { booked, covers }) => learned(known, booked, covers), UNKNOWN)
    expect(bySpace(shuffled.reduce((known, { booked, covers }) => learned(known, booked, covers), UNKNOWN))).toEqual(bySpace(inOrder))
    for (const space of SPACES) {
      const newest = all.filter(({ covers }) => covers.includes(space)).toSorted((a, b) => b.booked.fetched - a.booked.fetched)[0]
      expect(bySpace(inOrder)[space] ?? []).toEqual(newest ? bySpace({ ...UNKNOWN, bookings: newest.booked.bookings.filter(booking => booking.space === space) })[space] ?? [] : [])
      expect(fetchedOf(inOrder, space)).toBe(newest?.booked.fetched ?? 0)
    }
  }))
})

test("a court's bookings are its own and its gym's, each once", () => {
  const own = { space: "court", start: 0, end: 10, type: "Intramural Volleyball" }
  const gym = [{ ...own, space: "gym" }, { space: "gym", start: 20, end: 30, type: "Dance Team" }]
  expect(bookingsOf([own, ...gym], { id: "court", within: "gym" })).toEqual([own, gym[1]])
  expect(bookingsOf([own, ...gym], { id: "gym" })).toEqual(gym)
})

test("a room is busy till what's on there ends, run together, else free till what's next that day, and counts as free for half an hour or what's left of the day", () => {
  const busy = [{ start: at("09:00"), end: at("10:00") }, { start: at("10:00"), end: at("11:30") }, { start: at("14:00"), end: at("15:00") }]
  expect(joined(busy)).toEqual([{ start: at("09:00"), end: at("11:30") }, { start: at("14:00"), end: at("15:00") }])
  expect(standingAt(busy, at("09:30"))).toEqual({ isFree: false, until: at("11:30") })
  expect(standingAt(busy, at("12:00"))).toEqual({ isFree: true, until: at("14:00") })
  expect(standingAt(busy, at("16:00"))).toEqual({ isFree: true })
  expect(isFreeFor(standingAt(busy, at("13:45")), at("13:45"))).toBe(false)
  expect(isFreeFor(standingAt(busy, at("12:00")), at("12:00"))).toBe(true)
  expect(isFreeFor(standingAt(busy, at("23:45")), at("23:45"))).toBe(true)
})

test("however it's booked, a room stands free exactly when nothing's on there, till the next thing or the end of what's on", () => {
  const span = fc.record({ start: fc.integer({ min: 0, max: 1400 }), length: fc.integer({ min: 1, max: 180 }) }).map(({ start, length }) => ({ start: at("00:00") + start * 60_000, end: at("00:00") + (start + length) * 60_000 }))
  fc.assert(fc.property(fc.array(span, { maxLength: 8 }), fc.integer({ min: 0, max: 1439 }), (busy, minute) => {
    const now = at("00:00") + minute * 60_000
    const standing = standingAt(busy, now)
    expect(standing.isFree).toBe(!busy.some(({ start, end }) => start <= now && now < end))
    if (standing.isFree)
      expect(standing.until).toBe(busy.filter(({ start }) => start > now).map(({ start }) => start).sort((a, b) => a - b)[0])
    else
      expect(busy.some(({ end }) => end === standing.until)).toBe(true)
  }))
})

test("the Worker asks 25Live about yesterday through the month ahead, and a snapshot is a week", () => {
  const now = at("12:00")
  expect([-1, 0, 30].map(days => isAskable(addDays(DAY, days), now))).toEqual([true, true, true])
  expect([-3, 32, 400].map(days => isAskable(addDays(DAY, days), now))).toEqual([false, false, false])
  expect(weekFrom(DAY)).toEqual([0, 1, 2, 3, 4, 5, 6].map(days => addDays(DAY, days)))
})
