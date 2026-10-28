// Structured data (src/shell/structured.mts) as Google documents it: every official event placed in Durham is an Event
// with the required name, start and location with an address, and the recommended end, status, attendance mode,
// description, image, and organizer where its calendar has one; an event made here, or placed nowhere in Durham, is
// none; and every date is ISO 8601 on Durham's clock with its offset, to the second
// (https://developers.google.com/search/docs/appearance/structured-data/event)

import { test, expect } from "vitest"
import fc from "fast-check"
import { breadcrumbsOf, eventDataOf } from "../../src/shell/structured.mts"
import { type Event, SOURCES } from "../../src/social/event.mts"
import { CHAPTERS, isPlaced } from "../../src/places/chapters.mts"
import { isoOf } from "../../src/shared/time.mts"

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/

// From a day in term to five years on
const NOW = Date.UTC(2026, 9, 7, 16)
const instant = fc.integer({ min: NOW, max: NOW + 5 * 365 * 86_400_000 })

const event: fc.Arbitrary<Event> = fc.record({
  id:     fc.string({ minLength: 1 }),
  title:  fc.string({ minLength: 1, maxLength: 80 }),
  start:  instant,
  end:    instant,
  place:  fc.constant("Memorial Union Building"),
  where:  fc.string({ maxLength: 80 }),
  source: fc.constantFrom(...SOURCES),
  url:    fc.webUrl()
})

/** On campus, or a few kilometers out, as far as Durham's edge */
const place = fc.record({
  name: fc.constantFrom("Memorial Union Building", ...CHAPTERS.filter(isPlaced).map(({ name }) => name)),
  at:   fc.tuple(fc.double({ min: -70.95, max: -70.92, noNaN: true }), fc.double({ min: 43.12, max: 43.15, noNaN: true }))
})

const URL = "https://notunh.app/map/event/x"
const IMAGE = "https://notunh.app/map/card/event/x?v=0"

test("an instant is ISO 8601 on Durham's clock with its offset, the same instant to the second", () =>
  fc.assert(fc.property(fc.integer({ min: Date.parse("2020-01-01"), max: Date.parse("2040-01-01") }), ms => {
    const iso = isoOf(ms)
    expect(iso).toMatch(ISO)
    expect(iso.slice(-6)).toMatch(/^-0[45]:00$/)
    expect(Date.parse(iso)).toBe(Math.floor(ms / 1000) * 1000)
  }))
)

test("every official event placed in Durham has what Google requires and recommends of an Event, and nothing it doesn't know", () =>
  fc.assert(fc.property(event, place, fc.string(), (event, place, description) => {
    const data = eventDataOf({ event, place, url: URL, image: IMAGE, description })
    if (event.source === "pin" || event.source === "course") {
      expect(data).toBeUndefined()
      return
    }
    const thing = data as Record<string, any>
    // Required
    expect(thing["@context"]).toBe("https://schema.org")
    expect(thing["@type"]).toBe("Event")
    expect(thing.name).toBe(event.title)
    expect(thing.startDate).toMatch(ISO)
    expect(Date.parse(thing.startDate)).toBe(Math.floor(event.start / 1000) * 1000)
    expect(thing.location).toMatchObject({ "@type": "Place", name: place.name, address: { "@type": "PostalAddress", addressLocality: "Durham", addressRegion: "NH", postalCode: "03824", addressCountry: "US" } })
    // Recommended, as far as it's known
    if (event.end > event.start) {
      expect(thing.endDate).toMatch(ISO)
      expect(Date.parse(thing.endDate)).toBeGreaterThanOrEqual(Date.parse(thing.startDate))
    }
    else
      expect(thing.endDate).toBeUndefined()
    expect(thing.eventStatus).toBe("https://schema.org/EventScheduled")
    expect(thing.eventAttendanceMode).toBe("https://schema.org/OfflineEventAttendanceMode")
    expect(thing.description).toBe(description)
    expect(thing.image).toEqual([IMAGE])
    expect(thing.url).toBe(URL)
    if (event.source === "presence")
      expect(thing.organizer).toBeUndefined()
    else
      expect(thing.organizer).toMatchObject({ "@type": "Organization", name: expect.any(String), url: expect.stringMatching(/^https:\/\//) })
    // A chapter's house has its street address
    const house = CHAPTERS.find(({ name }) => name === place.name)?.house
    expect(thing.location.address.streetAddress).toBe(house?.address)
    // What isn't known is never said
    for (const unknown of ["offers", "performer", "isAccessibleForFree", "previousStartDate"])
      expect(thing, unknown).not.toHaveProperty(unknown)
    expect(JSON.parse(JSON.stringify(thing))).toEqual(thing)
  }))
)

test("an event placed nowhere the map knows, or out of Durham, has no structured data", () => {
  const official: Event = { id: "a", title: "A", start: NOW, end: NOW + 3_600_000, where: "", source: "25live", url: "" }
  expect(eventDataOf({ event: official, place: undefined, url: URL, image: IMAGE, description: "" })).toBeUndefined()
  // Portsmouth
  expect(eventDataOf({ event: official, place: { name: "Market Square", at: [-70.7593, 43.0771] }, url: URL, image: IMAGE, description: "" })).toBeUndefined()
})

test("breadcrumbs count from 1, each linking where it has an address", () => {
  expect(breadcrumbsOf([{ name: "notunh", url: "https://notunh.app/" }, { name: "Map", url: "https://notunh.app/map/" }, { name: "Kingsbury Hall" }])).toEqual({
    "@context":      "https://schema.org",
    "@type":         "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "notunh", item: "https://notunh.app/" },
      { "@type": "ListItem", position: 2, name: "Map", item: "https://notunh.app/map/" },
      { "@type": "ListItem", position: 3, name: "Kingsbury Hall" }
    ]
  })
})
