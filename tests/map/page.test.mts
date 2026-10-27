import { test, expect, vi } from "vitest"
import fc from "fast-check"
import { type Page, fieldOf, fromField, isSameView, pageOf, urlOf } from "../../src/map/link.mts"
import { createPage } from "../../src/map/state/page.mts"
import type { Purpose, Stay } from "../../src/parking/model.mts"
import { sectionUrl } from "../../src/courses/course.mts"
import { addDays, atClock, localDay } from "../../src/shared/time.mts"

/**
 * A name as places, rooms and ids have them, any text a page could be of: unicode, slashes, plus signs, percent signs,
 * colons and question marks included, never only dots, which a URL takes for its own
 */
const aText = fc.oneof(fc.string({ minLength: 1, unit: "grapheme" }), fc.string({ minLength: 1 }), fc.constantFrom("N/A", "Café 1+1", "50% off?", "a#b", "Ham Smith & Co.", "名前", "x:y"))
  .filter(text => text.trim() === text && !/^\.+$/.test(text))
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
  fc.record({ kind: fc.constant("program" as const), slug: fc.option(aText, { nil: undefined }), course: fc.option(aText, { nil: undefined }) }).map(withoutNone),
  fc.record({ kind: fc.constantFrom("directions" as const, "you" as const, "buses" as const) })
)

/** The page a link opens, as a browser reads it */
const opened = (url: string) => {
  const { pathname, search } = new URL(url, "https://notunh.app")
  return pageOf(pathname, search)
}

test("every page's link is a path that opens that page again, and the map's opens none", () => {
  fc.assert(fc.property(aPage, page => {
    const url = urlOf(page)
    expect(url).toMatch(/^\/map\/[a-z]+(\/[^/?#]+){0,2}(\?|$)/)
    expect(opened(url)).toEqual(page)
  }))
  expect(urlOf()).toBe("/map/")
  expect(opened("/map/")).toBeUndefined()
  expect(urlOf({ kind: "you" })).toBe("/map/you")
  expect(urlOf({ kind: "new" })).toBe("/map/new")
  expect(opened("/map/directions")).toEqual({ kind: "directions" })
  expect(opened("/map/new/Kingsbury+Hall")).toEqual({ kind: "new", place: "Kingsbury Hall" })
  expect(urlOf({ kind: "room", where: "Kingsbury N/A 1+1" })).toBe("/map/room/Kingsbury+N%2FA+1%2B1")
})

test("a section's link reads as its term and CRN, and what isn't a page is none", () => {
  expect(urlOf({ kind: "section", term: "202610", crn: "12496" })).toBe("/map/section/202610/12496")
  expect(urlOf({ kind: "room", where: "Kingsbury N343" })).toBe("/map/room/Kingsbury+N343")
  expect(urlOf({ kind: "event", id: "25live:1" })).toBe("/map/event/25live:1")
  for (const url of ["/map/section/12496", "/map/section/202610/12496/x", "/map/place", "/map/place/a/b", "/map/nowhere/x", "/map/place/%E0%A4%A", "/map/you/x", "/dining/place/x", "/map/?to=laundry/stoke-hall-g05"])
    expect(opened(url), url).toBeUndefined()
})

test("parking's links carry the stay on Durham's clock and what it's for, never ?to=, and drop either where it makes no sense", () => {
  const day = addDays(localDay(Date.now()), 1)
  const stay = { from: atClock(day, "06:30"), to: atClock(day, "08:30") }
  expect(urlOf({ kind: "parking", place: "Kingsbury Hall", stay, purpose: "class" })).toBe(`/map/parking/Kingsbury+Hall?arrive=${day}T06:30&leave=${day}T08:30&for=class`)
  expect(urlOf({ kind: "parking" })).toBe("/map/parking")
  expect(opened(`/map/area/B?arrive=${day}T08:30&leave=${day}T06:30&for=nap`)).toEqual({ kind: "area", id: "B" })
  expect(opened("/map/area/B?arrive=yesterday&leave=today")).toEqual({ kind: "area", id: "B" })
  expect(new URL(urlOf({ kind: "area", id: "B", stay }), "https://notunh.app").searchParams.has("to")).toBe(false)
  expect(urlOf({ kind: "program", slug: "computer-science-minor", course: "CS 518" })).toBe("/map/program/computer-science-minor?course=CS+518")
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

test("the links the courses make for themselves, below the map, open the pages the map makes them as", () =>
  fc.assert(fc.property(fc.stringMatching(/^\d{4}[1357]0$/), fc.stringMatching(/^\d{5}$/), (term, crn) => {
    expect(sectionUrl(term, crn)).toBe(urlOf({ kind: "section", term, crn }))
  }))
)

/**
 * The browser's history for one visit, as the page sees it: its entries, the one it's at, and Back and Forward, which
 * say so to popstate's listener as they arrive
 */
const historyOf = () => {
  const entries: { state: unknown, url: string }[] = [{ state: null, url: "/map/" }]
  let at = 0
  let popped = () => {}
  const arrive = (to: number) => {
    at = to
    const { pathname, search } = new URL(entries[at].url, "https://notunh.app")
    vi.stubGlobal("location", { pathname, search })
    popped()
  }
  vi.stubGlobal("location", { pathname: "/map/", search: "" })
  vi.stubGlobal("addEventListener", (type: string, listener: () => void) => type === "popstate" && (popped = listener))
  vi.stubGlobal("history", {
    get state() { return entries[at].state },
    pushState: (state: unknown, _: string, url: string) => {
      entries.splice(at + 1, Infinity, { state, url })
      arrive(at + 1)
    },
    replaceState: (state: unknown, _: string, url = entries[at].url) => entries[at] = { state, url },
    back: () => at > 0 && arrive(at - 1),
    forward: () => at < entries.length - 1 && arrive(at + 1)
  })
  return { canGoBack: () => at > 0, canGoForward: () => at < entries.length - 1, forward: () => history.forward() }
}

type Step =
  | { kind: "open", page: Page }
  | { kind: "scroll", top: number }
  | { kind: "back" | "browser back" | "forward" }

const aStep: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("open" as const), page: aPage }),
  fc.record({ kind: fc.constant("scroll" as const), top: fc.integer({ min: 0, max: 5000 }) }),
  fc.record({ kind: fc.constantFrom("back" as const, "browser back" as const, "forward" as const) })
)

test("a page opened starts at its top, and one Back or Forward returns to is scrolled where it was left", () =>
  fc.assert(fc.property(fc.array(aStep, { maxLength: 40 }), steps => {
    const browser = historyOf()
    const pages = createPage(() => {})
    // Where each entry was left, by its place in the history, and where the one shown is
    const left: (number | undefined)[] = [undefined]
    let at = 0
    let scrolled = 0
    const arrive = (to: number) => {
      left[at] = scrolled
      at = to
      expect(pages.scrollTo.peek().top).toBe(left[at] ?? 0)
      scrolled = pages.scrollTo.peek().top
      pages.scrolled.value = scrolled
    }
    for (const step of steps) {
      if (step.kind === "open") {
        pages.go(step.page)
        left.splice(at + 1, Infinity, undefined)
        arrive(at + 1)
      }
      else if (step.kind === "scroll")
        pages.scrolled.value = scrolled = step.top
      else if (step.kind === "forward") {
        if (browser.canGoForward()) {
          browser.forward()
          arrive(at + 1)
        }
      }
      else if (browser.canGoBack()) {
        if (step.kind === "back")
          pages.back()
        else
          history.back()
        arrive(at - 1)
      }
      // Back from the page a visit opened at goes to the map, at its top
      else if (step.kind === "back") {
        pages.back()
        expect(pages.scrollTo.peek().top).toBe(0)
        pages.scrolled.value = scrolled = 0
      }
    }
    vi.unstubAllGlobals()
  }))
)
