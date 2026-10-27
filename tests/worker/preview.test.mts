/// <reference types="node" />
// Link previews (worker/preview.mts): each of the map's pages is the map with what it's of in its head and a card
// of its own, as a pin's page is; whatever doesn't resolve is the page as built, without an error; cards are PNGs,
// kept only under their current version; and heads stay well-formed whatever they're given

import { test, expect, vi, beforeAll, afterAll } from "vitest"
import fc from "fast-check"
import { app } from "../../worker/api.mts"
import type { Env } from "../../worker/env.mts"
import { type Head, headOf, versionOf, withHead } from "../../worker/preview.mts"
import { cardOf, drawable } from "../../worker/card.mts"
import type { Section } from "../../src/courses/course.mts"
import { emptyCalendar } from "../../src/courses/calendar.mts"
import { hide, reveal } from "../../src/courses/email.mts"
import { HOUR, addDays, dayStart, localDay } from "../../src/shared/time.mts"
import { segmentOf } from "../../src/map/link.mts"
import { d1 } from "./d1.mts"

// Nine in the morning today, whenever today is, so what's on at 1:30 is today's
const NOW = dayStart(localDay(Date.now())) + 9 * HOUR
const TODAY = localDay(NOW)
const at = (hours: number) => dayStart(TODAY) + hours * HOUR

const ADA = hide("ada.lovelace@unh.edu")

const SECTION: Section = {
  crn: "12496", subject: "CS", number: "518", section: "01", title: "Data Structures", kind: "LEC", mode: "IPFF", credits: "4.0",
  from: addDays(TODAY, -30), to: addDays(TODAY, 60), instructors: [{ name: "Ada Lovelace", mail: ADA }], crossListed: [],
  meetings: [{ days: "TR", start: 850, end: 930, from: addDays(TODAY, -30), to: addDays(TODAY, 60), place: "Kingsbury Hall", where: "Kingsbury N343" }]
}

/** The built site's files, by path, as the Worker reads them from its assets */
const FILES: Record<string, unknown> = {
  "/assets/events-x.json": {
    fetched: NOW,
    events:  [{ id: "25live:1", title: "Honors Drop In Advising", start: at(13.5), end: at(14 + 40 / 60), place: "Huddleston Hall", where: "", source: "25live", url: "https://example.com" }]
  },
  "/assets/gazetteer-x.json": { made: { extract: "2026-10-01", generator: "x" }, places: [{ name: "Huddleston Hall", kind: "building", at: [-70.93, 43.13] }] },
  "/assets/courses-x.json": {
    built: 0, calendar: emptyCalendar(), files: ["/data/courses/fall.json"],
    terms: [{ code: "202610", name: "Fall 2026", from: addDays(TODAY, -30), to: addDays(TODAY, 60), fetched: 0, sections: 1, file: "/data/courses/fall.json" }]
  },
  "/data/courses/fall.json": { code: "202610", sections: [SECTION] },
  "/assets/prereqs-x.json": { fetched: 0, year: "2026-2027", programs: "/data/programs/list.json", files: [] },
  "/data/programs/list.json": { fetched: 0, programs: [{ slug: "computer-science-minor", title: "Computer Science Minor", kind: "minor", file: "/data/programs/cs.json" }], courses: {} },
  "/data/programs/cs.json": { slug: "computer-science-minor", title: "Computer Science Minor", kind: "minor", url: "", year: "2026-2027", courses: ["CS 415", "CS 416", "CS 518"], titles: {} },
  "/assets/parking-x.json": { sources: { zones: 0, parkMobile: 0, osm: 0 }, built: 0, areas: [{ id: "B", name: "B Lot", permits: ["faculty"], always: false, osm: [], at: [-70.93, 43.13], spaces: 573 }] },
  "/assets/gtfs-x.json": {
    version: "x", start: TODAY, end: TODAY, services: {}, shapes: {},
    routes: [{ id: "Gables", name: "Gables Connector", long: "Gables Connector", color: "", text: "" }],
    stops:  [{ id: "101", name: "McConnell Hall", lat: 43.13, lon: -70.93 }],
    trips:  [{ id: "t", route: "Gables", service: "s", headsign: "", shape: "", stops: [0], times: [0], timepoints: [] }]
  }
}

const NAMES = ["events", "gazetteer", "courses", "prereqs", "parking", "gtfs"]

const head = (release: string, names: Record<string, string>) => `<head><meta charset="UTF-8"><title>UNH Campus Map · notunh</title><meta name="description" content="Every bus live"><meta name="release" content="${release}"><meta property="og:title" content="UNH Campus Map · notunh"><meta property="og:description" content="Every bus live"><meta property="og:url" content="https://notunh.app/map/"><meta property="og:image" content="https://notunh.app/social/map.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="notunh: Buses &amp; directions"><meta name="twitter:title" content="UNH Campus Map · notunh"><meta name="twitter:description" content="Every bus live"><meta name="twitter:image" content="https://notunh.app/social/map.png"><meta name="twitter:image:alt" content="notunh: Buses &amp; directions">${Object.entries(names).map(([name, href]) => `<link rel="data" href="${href}" data-name="${name}">`).join("")}</head>`

// The body says things a head does, which are never touched
const BODY = `<body><svg><title>Not the page's</title></svg><meta name="description" content="Not the page's either"></body>`
const MAP = `<!doctype html><html lang="en-US">${head("2026-10-27T08:00:00.000Z", Object.fromEntries(NAMES.map(name => [name, `/assets/${name}-x.json`])))}${BODY}</html>`
const PIN_PAGE = `<!doctype html><html>${head("2026-10-27T08:00:00.000Z", {}).replace("UNH Campus Map", "An event")}<body><div id="app"></div></body></html>`

/** A Worker with a fresh database, the built site as its assets, which keeps every request it's asked */
const worker = (files = FILES, map = MAP) => {
  const asked: Request[] = []
  const env = {
    DB: d1(),
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const request = new Request(input)
        asked.push(request)
        const { pathname } = new URL(request.url)
        return pathname === "/map/" ? new Response(map, { headers: { "content-type": "text/html", etag: "\"built\"" } }) :
          pathname === "/p/" ? new Response(PIN_PAGE, { headers: { "content-type": "text/html" } }) :
          pathname in files ? Response.json(files[pathname]) :
          new Response("Not found", { status: 404 })
      }
    }
  } as unknown as Env
  const get = (path: string, init?: RequestInit) => app.fetch(new Request(`https://notunh.app${path}`, init), env)
  return { env, asked, get }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})

afterAll(() => {
  vi.useRealTimers()
})

/** Each meta's content in a page's head, and its title */
const headIn = async (response: Response) => {
  const html = await response.text()
  const [head] = html.split("</head>")
  return {
    html,
    title: head.match(/<title>([^<]*)<\/title>/)![1],
    meta:  Object.fromEntries([...head.matchAll(/<meta (?:name|property)="([^"]+)" content="([^"]*)">/g)].map(([, name, content]) => [name, content]))
  }
}

/** Today as the previews say it, by its date */
const DATED = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(NOW)

test("a page of the map that isn't of anything to preview is the map as built", async () => {
  const { get } = worker()
  for (const path of ["/map/directions", "/map/you", "/map/bus/12", "/map/event/nope", "/map/place/Nowhere", "/map/section/202610/99999", "/map/nowhere/x"])
    expect(await (await get(path)).text(), path).toBe(MAP)
})

test("a link to an event says what, when and where in the map's head, with a card of its own and the body untouched", async () => {
  const { get } = worker()
  const response = await get("/map/event/25live:1")
  expect(response.status).toBe(200)
  const { html, title, meta } = await headIn(response)
  expect(title).toBe("Honors Drop In Advising · notunh")
  expect(meta["description"]).toBe(`${DATED} 1:30 – 2:40 PM · Huddleston Hall`)
  expect(meta["og:description"]).toBe(meta["description"])
  expect(meta["twitter:title"]).toBe(title)
  expect(meta["og:url"]).toBe("https://notunh.app/map/event/25live:1")
  expect(meta["og:image"]).toMatch(/^https:\/\/notunh\.app\/map\/card\/event\/25live:1\?v=[0-9a-f]{12}$/)
  expect(meta["twitter:image"]).toBe(meta["og:image"])
  expect(html.endsWith(`${BODY}</html>`)).toBe(true)
  // The build's manifest is untouched, so the page is the same build to the service worker
  expect(html).toContain(`<meta name="release" content="2026-10-27T08:00:00.000Z">`)
  expect(html.match(/data-name=/g)).toHaveLength(NAMES.length)
})

test("each kind of page shared previews as what it's of", async () => {
  const { get } = worker()
  const said = async (path: string) => {
    const { title, meta } = await headIn(await get(path))
    return [title, meta["description"]]
  }
  expect(await said("/map/place/Huddleston+Hall")).toEqual(["Huddleston Hall · notunh", `Next: Honors Drop In Advising · ${DATED} 1:30 – 2:40 PM`])
  expect(await said("/map/section/202610/12496")).toEqual(["Data Structures · notunh", "Tue Thu 2:10 – 3:30 PM · Kingsbury N343"])
  expect(await said("/map/course/CS+518")).toEqual(["CS 518 · Data Structures · notunh", "Fall 2026: 1 section"])
  expect(await said(`/map/person/${segmentOf(ADA)}`)).toEqual(["Ada Lovelace · notunh", "Teaches CS 518 · Fall 2026"])
  expect(await said("/map/room/Kingsbury+N343")).toEqual(["Kingsbury N343 · notunh", "Classes: CS 518"])
  expect(await said("/map/program/computer-science-minor?course=CS+518")).toEqual(["Computer Science Minor · notunh", "3 courses, what each needs, and where they meet"])
  expect(await said("/map/parking/Huddleston+Hall?arrive=2026-10-27T06:30&leave=2026-10-27T08:30")).toEqual(["Parking near Huddleston Hall · notunh", "Lots and meters for your stay, with the walk"])
  expect(await said("/map/area/B")).toEqual(["B Lot · notunh", "573 spaces · What you can park here, and till when"])
  expect(await said("/map/stop/101")).toEqual(["McConnell Hall · notunh", "Buses: Gables Connector"])
})

test("an instructor's address appears nowhere a preview of them goes, hidden or in the clear, but in the link already shared", async () => {
  const { get } = worker()
  const { html, meta } = await headIn(await get(`/map/person/${segmentOf(ADA)}`))
  expect(html).not.toContain(reveal(ADA))
  expect(html).not.toContain("@")
  // Only in the page's own link and its card's, which carry its query as shared
  expect(new URL(meta["og:url"]).pathname).toBe(`/map/person/${segmentOf(ADA)}`)
  expect(new URL(meta["og:image"]).pathname).toBe(`/map/card/person/${segmentOf(ADA)}`)
  expect(meta["description"]).not.toContain(ADA)
})

test("an event made here previews at its own page and on the map, and one gone or hidden is the page as built", async () => {
  const { env, get } = worker()
  const id = "pin-preview-000000"
  const secret = "secret-of-ana-the-host"
  const made = await app.fetch(new Request("https://notunh.app/api/pins", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ device: "ana".padEnd(16, "_"), id, title: "Tea & <cake>", description: "", place: "Memorial Union Building", where: "", times: [{ start: at(16), end: at(17) }], visibility: "link" })
  }), env)
  expect(made.status).toBe(201)
  for (const path of [`/p/${id}`, `/map/event/${id}`]) {
    const { title, meta } = await headIn(await get(path))
    expect(title, path).toBe("Tea &amp; &lt;cake&gt; · notunh")
    expect(meta["description"], path).toBe(`${DATED} 4:00 – 5:00 PM · Memorial Union Building`)
    expect(meta["og:image"], path).toMatch(new RegExp(`/map/card/event/${id}\\?v=`))
  }
  expect((await headIn(await get(`/p/${id}`))).meta["og:url"]).toBe(`https://notunh.app/p/${id}`)
  const gone = await get("/p/pin-gone-00000000000")
  expect(gone.status).toBe(404)
  expect(await gone.text()).toBe(PIN_PAGE)
})

test("a card is a 1200 by 630 PNG, kept for good only under the version its page names, else briefly, and the map's own for a page of nothing", async () => {
  const { get } = worker()
  const { meta } = await headIn(await get("/map/event/25live:1"))
  const url = new URL(meta["og:image"])
  const card = await get(url.pathname + url.search)
  expect(card.status).toBe(200)
  expect(card.headers.get("content-type")).toBe("image/png")
  expect(card.headers.get("cache-control")).toContain("immutable")
  const png = new DataView(await card.arrayBuffer())
  expect(png.getUint32(0)).toBe(0x89504e47)
  expect([png.getUint32(16), png.getUint32(20)]).toEqual([1200, 630])

  url.searchParams.set("v", "000000000000")
  expect((await get(url.pathname + url.search)).headers.get("cache-control")).toBe("public, max-age=600")
  const nothing = await get("/map/card/event/nope")
  expect(nothing.status).toBe(302)
  expect(nothing.headers.get("location")).toBe("/social/map.png")
})

test("a page whose data can't be read is the page as built, logged, never an error", async () => {
  const broken = { ...FILES }
  delete broken["/data/courses/fall.json"]
  const { get } = worker(broken, MAP.replace("2026-10-27T08:00:00.000Z", "2026-10-28T08:00:00.000Z"))
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const response = await get("/map/section/202610/12496")
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("<title>UNH Campus Map · notunh</title>")
  expect(error).toHaveBeenCalled()
  error.mockRestore()
})

test("a card's version changes with anything it says, and only then", () =>
  fc.assert(fc.asyncProperty(fc.string(), fc.string(), fc.array(fc.string(), { maxLength: 3 }), fc.string({ minLength: 1 }), async (kind, title, lines, more) => {
    const preview = { kind, title, lines }
    expect(await versionOf({ ...preview })).toBe(await versionOf(preview))
    expect(await versionOf({ ...preview, title: title + more })).not.toBe(await versionOf(preview))
    expect(await versionOf({ ...preview, lines: [...lines, more] })).not.toBe(await versionOf(preview))
  }))
)

test("whatever a preview says, the head stays well-formed, a title of dollar signs included, and the body as it was", () =>
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 80 }), fc.constant("$& $1 $' $$")), fc.array(fc.string({ maxLength: 40 }), { maxLength: 3 }), (title, lines) => {
    const head: Head = headOf({ kind: "Event", title, lines }, "https://notunh.app/map/event/a", "https://notunh.app/map/card/event/a?v=0")
    const html = withHead(MAP, head)
    const [before, after] = html.split("</head>")
    expect(after).toBe(MAP.split("</head>")[1])
    const metas = [...before.matchAll(/<meta (?:name|property)="[^"]+" content="([^"]*)">/g)]
    expect(metas).toHaveLength(13)
    for (const [, content] of metas)
      expect(content).not.toMatch(/[<>"]/)
    const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!)
    expect(before).toContain(`<title>${escape(head.title)}</title>`)
    expect(before).toContain(`<meta name="description" content="${escape(head.description)}">`)
  }))
)

test("a card draws text the font has, without emoji or the spaces they leave", () => {
  expect(drawable("🎃 Pumpkin  Carving 🎃🏻 ")).toBe("Pumpkin Carving")
  expect(drawable("Café · Crêpes – 7:00 PM")).toBe("Café · Crêpes – 7:00\u00a0PM")
  fc.assert(fc.property(fc.string(), text => {
    expect(drawable(text)).not.toMatch(/\p{Extended_Pictographic}|^\s|\s$|\s\s|\d [AP]M/u)
  }))
  expect(JSON.stringify(cardOf({ kind: "Event", title: "Tennis 🎾", lines: ["Today 3:00 – 4:00 PM", "Field House"] }))).not.toContain("🎾")
})
