import { test, expect } from "vitest"
import fc from "fast-check"
import { type Page, fieldOf, fromField, isSameView, pageOf, urlOf } from "../../src/map/state/page.mts"
import type { Purpose, Stay } from "../../src/parking/model.mts"
import { sectionUrl } from "../../src/courses/course.mts"
import { mapPath } from "../../src/social/event.mts"
import { addDays, atClock, localDay } from "../../src/shared/time.mts"

const aText = fc.string({ minLength: 1 }).filter(text => text.trim() === text && text.length > 0)
/** An instant on a whole minute of Durham's clock within a year either way, one a field writes back as itself */
const aMinute = fc.tuple(fc.integer({ min: -365, max: 365 }), fc.integer({ min: 0, max: 1439 }))
  .map(([days, minute]) => atClock(addDays(localDay(Date.now()), days), `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`))
  .filter(at => fromField(fieldOf(at)) === at)
const aStay: fc.Arbitrary<Stay> = fc.tuple(aMinute, fc.integer({ min: 1, max: 72 * 60 }))
  .map(([from, minutes]) => ({ from, to: from + minutes * 60_000 }))
  .filter(({ to }) => fromField(fieldOf(to)) === to)
const parking = { stay: fc.option(aStay, { nil: undefined }), purpose: fc.constantFrom<Purpose | undefined>(undefined, "class", "errand", "event", "visit") }
const withoutNone = <T extends object>(page: T) =>
  Object.fromEntries(Object.entries(page).filter(([, value]) => value !== undefined)) as T
const aPage: fc.Arbitrary<Page> = fc.oneof(
  fc.record({ kind: fc.constant("section" as const), term: fc.constantFrom("202610", "202630", "202650"), crn: fc.stringMatching(/^\d{5}$/) }),
  fc.record({ kind: fc.constantFrom("person" as const, "event" as const), id: aText }),
  fc.record({ kind: fc.constant("room" as const), where: aText }),
  fc.record({ kind: fc.constant("course" as const), code: aText }),
  fc.record({ kind: fc.constant("place" as const), name: aText }),
  fc.record({ kind: fc.constant("parking" as const), place: fc.option(aText, { nil: undefined }), ...parking }).map(withoutNone),
  fc.record({ kind: fc.constant("area" as const), id: aText, ...parking }).map(withoutNone),
  fc.record({ kind: fc.constantFrom("stop" as const, "bus" as const), id: aText }),
  fc.record({ kind: fc.constant("new" as const), place: fc.option(aText, { nil: undefined }) }).map(withoutNone),
  fc.record({ kind: fc.constantFrom("directions" as const, "you" as const, "buses" as const) })
)

test("every page's link opens that page again, and the map's opens none", () => {
  fc.assert(fc.property(aPage, page => {
    const url = urlOf(page)
    expect(url).toMatch(/^\/map\/\?\w+(=|$)/)
    expect(pageOf(url.slice("/map/".length))).toEqual(page)
  }))
  expect(urlOf()).toBe("/map/")
  expect(pageOf("")).toBeUndefined()
  // A page that is what it is with no value stands as its parameter alone
  expect(urlOf({ kind: "you" })).toBe("/map/?you")
  expect(urlOf({ kind: "new" })).toBe("/map/?new=")
  expect(pageOf("?directions")).toEqual({ kind: "directions" })
  expect(pageOf("?new=Kingsbury+Hall")).toEqual({ kind: "new", place: "Kingsbury Hall" })
})

test("a section's link reads as its term and CRN, and one that isn't either is no page", () => {
  expect(urlOf({ kind: "section", term: "202610", crn: "12496" })).toBe("/map/?section=202610:12496")
  expect(urlOf({ kind: "room", where: "Kingsbury N343" })).toBe("/map/?room=Kingsbury+N343")
  expect(pageOf("?section=12496")).toBeUndefined()
  expect(pageOf("?section=202610:12496&person=x")).toEqual({ kind: "section", term: "202610", crn: "12496" })
  expect(pageOf("?section=junk&course=CS+518")).toEqual({ kind: "course", code: "CS 518" })
  expect(pageOf("?to=laundry/stoke-hall-g05")).toBeUndefined()
  // Links to events made before they were named so still open them
  expect(pageOf("?pin=abc")).toEqual({ kind: "event", id: "abc" })
  expect(urlOf({ kind: "event", id: "abc" })).toBe("/map/?event=abc")
})

test("parking's links carry the stay on Durham's clock and what it's for, never &to=, and drop either where it makes no sense", () => {
  const day = addDays(localDay(Date.now()), 1)
  const stay = { from: atClock(day, "06:30"), to: atClock(day, "08:30") }
  expect(urlOf({ kind: "parking", place: "Kingsbury Hall", stay, purpose: "class" })).toBe(`/map/?parking=Kingsbury+Hall&arrive=${day}T06:30&leave=${day}T08:30&for=class`)
  expect(urlOf({ kind: "parking" })).toBe("/map/?parking=")
  expect(pageOf("?parking")).toEqual({ kind: "parking" })
  expect(pageOf(`?area=B&arrive=${day}T08:30&leave=${day}T06:30&for=nap`)).toEqual({ kind: "area", id: "B" })
  expect(pageOf("?area=B&arrive=yesterday&leave=today")).toEqual({ kind: "area", id: "B" })
  expect(new URLSearchParams(urlOf({ kind: "area", id: "B", stay }).slice("/map/".length)).has("to")).toBe(false)
})

test("a page is the same view whatever stay or purpose parking's fields ask it for, and another place or area is another", () =>
  fc.assert(fc.property(aPage, aPage, (a, b) => {
    expect(isSameView(a, a)).toBe(true)
    if (a.kind === "parking" || a.kind === "area")
      expect(isSameView(a, { ...a, stay: undefined, purpose: "errand" })).toBe(true)
    if (urlOf(a) !== urlOf(b) && !(a.kind === b.kind && (a.kind === "parking" || a.kind === "area")))
      expect(isSameView(a, b)).toBe(false)
    expect(isSameView(a, undefined)).toBe(false)
  }))
)

test("the links the courses and events make for themselves, below the map, open the pages the map makes them as", () =>
  fc.assert(fc.property(fc.stringMatching(/^\d{4}[1357]0$/), fc.stringMatching(/^\d{5}$/), aText, (term, crn, id) => {
    expect(sectionUrl(term, crn)).toBe(urlOf({ kind: "section", term, crn }))
    expect(pageOf(new URL(mapPath(id), "https://notunh.app").search)).toEqual({ kind: "event", id })
  }))
)
