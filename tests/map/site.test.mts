// The map's pages worth finding (src/map/listed.mts), from the fixtures' data at any instant across their events: each
// is its own address back through pageOf, of something there is (src/map/site.mts), and never an instructor's or an
// event over (scripts/search.mts lists them in the sitemap)

import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Site, UNLISTED, resolve } from "../../src/map/site.mts"
import { listedPages } from "../../src/map/listed.mts"
import { pageOf, urlOf, viewOf } from "../../src/map/link.mts"
import { EventsData } from "../../src/social/event.mts"
import { checked } from "../../src/shared/json.mts"

const FIXTURES = new URL("../fixtures/data/", import.meta.url)

/** The map page's data files by name, as the fixtures have them, and the buildings, which the build matches */
const SOURCES: Record<string, string> = {
  events: "src/map/events.json", gazetteer: "src/map/gazetteer.json", gtfs: "src/map/gtfs.json", courses: "src/courses/courses.json",
  prereqs: "src/programs/prereqs.json", parking: "src/parking/parking.json"
}
const BUILDINGS = { inputs: "", buildings: [{ id: "dining/holloway-commons", kind: "dining", name: "Holloway Commons", lat: 43.135, lon: -70.934 }] }

const json = (path: string) =>
  readFile(new URL(path, FIXTURES), "utf8").then(JSON.parse)

// Each file read and checked once, as the Worker and the build keep theirs, since resolving every page asks for the
// same few files thousands of times over
const files = new Map<string, Promise<unknown>>()
const once = <T,>(key: string, read: () => Promise<T>) =>
  (files.get(key) ?? files.set(key, read()).get(key)!) as Promise<T>

const site: Site = {
  named: <T,>(name: string, schema: StandardSchemaV1<unknown, T>) =>
    once(`named:${name}`, async () => checked(schema, name === "places" ? BUILDINGS : await json(SOURCES[name]), name)),
  file: <T,>(path: string, schema: StandardSchemaV1<unknown, T>) =>
    once(`file:${path}`, async () => checked(schema, await json(`public${path}`), path))
}

const { events } = await site.named("events", EventsData)
const [first, last] = [Math.min(...events.map(({ start }) => start)), Math.max(...events.map(({ end }) => end))]
const instant = fc.integer({ min: first - 86_400_000, max: last + 86_400_000 })

test("every page listed is its own address, never an instructor's, each kind is among them, and the events are exactly those not over", () =>
  fc.assert(fc.asyncProperty(instant, async now => {
    const pages = await listedPages(site, now)
    const urls = pages.map(page => urlOf(page))
    expect(new Set(urls).size).toBe(urls.length)
    for (const [i, page] of pages.entries()) {
      expect(UNLISTED.includes(page.kind), urls[i]).toBe(false)
      expect(viewOf(pageOf(new URL(urls[i], "https://notunh.app").pathname)), urls[i]).toBe(urls[i])
    }
    const kinds = new Set(pages.map(({ kind }) => kind))
    for (const kind of ["place", "stop", "course", "section", "room", "program", "parking", "area"])
      expect(kinds, kind).toContain(kind)
    const listed = pages.flatMap(page => page.kind === "event" ? [page.id] : [])
    expect(listed.toSorted()).toEqual(events.filter(({ end }) => end > now).map(({ id }) => id).toSorted())
  }), { numRuns: 25 })
)

// Resolving every page reads nothing new, but there are over a thousand, so at the instants the listing turns on:
// before the first event, within them, and once the last is over
test.each([["before the events", first - 1], ["among the events", Math.floor((first + last) / 2)], ["after the events", last + 1]])(
  "every page listed %s is of something there is, and a place listed has something to say: something on, classes, a hall, or a chapter",
  async (_, now) => {
    const pages = await listedPages(site, now)
    for (const page of pages) {
      const found = await resolve(site, page, now)
      expect(found, urlOf(page)).toBeDefined()
      if (page.kind === "place")
        expect(found!.parts.filter(({ heading, items }) => heading !== "What's on" || items?.length).length, urlOf(page)).toBeGreaterThan(0)
    }
  }
)
