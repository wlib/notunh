// The map's pages worth finding (src/map/site.mts), from the fixtures' data at any instant across their events: each
// is its own address back through pageOf, of something there is, and never an instructor's or an event over
// (scripts/search.mts lists them in the sitemap)

import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Site, UNLISTED, listedPages, resolve } from "../../src/map/site.mts"
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

const site: Site = {
  named: async <T,>(name: string, schema: StandardSchemaV1<unknown, T>) =>
    checked(schema, name === "places" ? BUILDINGS : await json(SOURCES[name]), name),
  file: async <T,>(path: string, schema: StandardSchemaV1<unknown, T>) =>
    checked(schema, await json(`public${path}`), path)
}

const { events } = await site.named("events", EventsData)
const [first, last] = [Math.min(...events.map(({ start }) => start)), Math.max(...events.map(({ end }) => end))]
const instant = fc.integer({ min: first - 86_400_000, max: last + 86_400_000 })

test("every page listed is its own address, of something there is, never an instructor's, and no event over", () =>
  fc.assert(fc.asyncProperty(instant, async now => {
    const pages = await listedPages(site, now)
    const urls = pages.map(page => urlOf(page))
    expect(new Set(urls).size).toBe(urls.length)
    for (const page of pages) {
      const url = urlOf(page)
      expect(UNLISTED.includes(page.kind), url).toBe(false)
      expect(viewOf(pageOf(new URL(url, "https://notunh.app").pathname)), url).toBe(url)
      expect(await resolve(site, page, now), url).toBeDefined()
      if (page.kind === "event")
        expect(events.find(({ id }) => id === page.id)!.end, url).toBeGreaterThan(now)
    }
    const kinds = new Set(pages.map(({ kind }) => kind))
    for (const kind of ["place", "stop", "course", "section", "room", "program", "parking", "area"])
      expect(kinds, kind).toContain(kind)
    expect(pages.filter(({ kind }) => kind === "event")).toHaveLength(events.filter(({ end }) => end > now).length)
  }), { numRuns: 8 })
)

test("a place listed has something useful: something on, classes, a hall, or a chapter", async () => {
  const pages = await listedPages(site, first)
  for (const page of pages.filter(({ kind }) => kind === "place")) {
    const found = (await resolve(site, page, first))!
    const said = found.parts.filter(({ heading, items }) => heading !== "What's on" || items?.length)
    expect(said.length, urlOf(page)).toBeGreaterThan(0)
  }
})
