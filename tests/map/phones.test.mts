import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { CODES } from "../../src/courses/buildings.mts"
import { holds } from "../../src/geo/boxes.mts"
import { DISPATCH, PHONES, offersEscort, phonesFor, telOf } from "../../src/map/phones.mts"
import { Gazetteer, campusOf } from "../../src/places/gazetteer.mts"
import { placeOf } from "../../src/social/event.mts"

const ALL = PHONES.flatMap(({ phones }) => phones)

const { places } = v.parse(Gazetteer, JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8")))
const campus = campusOf(places)!
const [west, south, east, north] = campus

/** A place on campus, and one off it by up to some 20 km, past one of its edges */
const onCampus = fc.record({ lon: fc.double({ min: west, max: east, noNaN: true }), lat: fc.double({ min: south, max: north, noNaN: true }) })
const offCampus = fc.tuple(onCampus, fc.constantFrom("west", "south", "east", "north"), fc.double({ min: 0.0001, max: 0.2, noNaN: true })).map(([{ lon, lat }, side, by]) =>
  side === "west"  ? { lon: west - by, lat } :
  side === "east"  ? { lon: east + by, lat } :
  side === "south" ? { lon, lat: south - by } :
                     { lon, lat: north + by }
)
const aWalk = fc.integer({ min: 800, max: 4000 })
const aShortWalk = fc.integer({ min: 0, max: 799 })

test("every number is from a unh.edu page, dials as written, and names no one", () => {
  for (const phone of ALL) {
    expect(new URL(phone.source).hostname).toMatch(/(^|\.)unh\.edu$/)
    expect(new URL(phone.source).protocol).toBe("https:")
    expect(phone.number).toMatch(/^(\d{3}|\(\d{3}\) \d{3}-\d{4})$/)
    expect(telOf(phone)).toBe(phone.number.length === 3 ? phone.number : `+1${phone.number.replace(/\D/g, "")}`)
    expect(`${phone.name} ${phone.note ?? ""}`).not.toMatch(/@/)
  }
})

test("emergency comes first, 911 before UNH Police's dispatch", () => {
  expect(PHONES[0].heading).toBe("Emergency")
  expect(PHONES[0].phones.map(({ number }) => number)).toEqual(["911", DISPATCH.number])
})

test("search finds a number by the start of any word of its name or what else it's searched by, and the page for those or a word like phone", () => {
  expect(phonesFor("police").phones.map(({ number }) => number)).toEqual(["911", DISPATCH.number])
  expect(phonesFor("police disp").phones).toEqual([DISPATCH])
  expect(phonesFor("campus security").phones).toEqual([])
  expect(phonesFor("security").phones).toEqual([DISPATCH])
  expect(phonesFor("escort").phones).toEqual([DISPATCH])
  expect(phonesFor("COUNSEL").phones.map(({ name }) => name)).toEqual(["Psychological & Counseling Services"])
  expect(phonesFor("bus").phones.map(({ name }) => name)).toEqual(["Transportation"])
  expect(phonesFor("sharpp").isPage).toBe(true)
  expect(phonesFor("phone numbers")).toEqual({ isPage: true, phones: [] })
  expect(phonesFor("emergency").phones[0].number).toBe("911")
  expect(phonesFor("Kingsbury")).toEqual({ isPage: false, phones: [] })
  expect(phonesFor("po")).toEqual({ isPage: false, phones: [] })
})

test("a note's prose finds nothing, as its words are in anything typed", () => {
  for (const typed of ["the", "and", "any", "not", "you", "your", "week", "after", "hour", "build", "posted"])
    expect(phonesFor(typed)).toEqual({ isPage: false, phones: [] })
})

test("each number is found by its own name, and anything found is the page's too", () =>
  fc.assert(fc.property(fc.constantFrom(...ALL), fc.string(), (phone, typed) => {
    expect(phonesFor(phone.name).phones).toContain(phone)
    const found = phonesFor(typed)
    if (found.phones.length)
      expect(found.isPage).toBe(true)
  }))
)

test("the campus, as the gazetteer has it, holds every building the registrar schedules a class in, and stops short of downtown", () => {
  const scheduled = [...new Set(Object.values(CODES))].flatMap(name => placeOf(places, name ?? undefined) ?? [])
  expect(scheduled.length).toBeGreaterThan(30)
  for (const place of scheduled)
    expect(holds(campus, place), place.name).toBe(true)
  for (const name of ["West Edge Lot", "Gables N", "Stoke Hall", "University Police"])
    expect(places.filter(place => place.name === name).every(({ at: [lon, lat] }) => holds(campus, { lon, lat })), name).toBe(true)
  for (const name of ["Durham House of Pizza", "Libby's Bar & Grille", "Durham Town Hall", "Oyster River High School"])
    expect(places.filter(place => place.name === name).some(({ at: [lon, lat] }) => holds(campus, { lon, lat })), name).toBe(false)
})

test("the escort is offered with no bus, for a walk of ten minutes or so between two places on campus, and only then", () =>
  fc.assert(fc.property(onCampus, onCampus, aWalk, aShortWalk, (from, to, meters, short) => {
    expect(offersEscort({ from, to, hasBus: false, meters, campus })).toBe(true)
    expect(offersEscort({ from, to, hasBus: true, meters, campus })).toBe(false)
    expect(offersEscort({ from, to, hasBus: false, meters: short, campus })).toBe(false)
    expect(offersEscort({ from, to, hasBus: false, meters, campus: undefined })).toBe(false)
  }))
)

test("the escort is never offered to or from anywhere off campus", () =>
  fc.assert(fc.property(onCampus, offCampus, aWalk, fc.boolean(), (here, away, meters, isOut) => {
    const [from, to] = isOut ? [here, away] : [away, here]
    expect(offersEscort({ from, to, hasBus: false, meters, campus })).toBe(false)
  }))
)
