/// <reference types="node" />
// The Worker's calendar files (worker/calendar.mts): an event's, a series', a section's and a person's feed, each
// read back as the days and times its page shows, the feed by its token alone; and the guard on the one address the
// Worker asks for someone

import { test, expect, vi } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { app } from "../../worker/api.mts"
import { calendarAt, fetchable } from "../../worker/calendar.mts"
import type { Env } from "../../worker/env.mts"
import { type CoursesIndex, type TermFile, meets, occurrences, termOf } from "../../src/courses/course.mts"
import type { EventsData } from "../../src/social/event.mts"
import { calendarPath } from "../../src/social/calendar.mts"
import { slugOf } from "../../src/social/curated.mts"
import { seriesOf } from "../../src/social/series.mts"
import { readEvents } from "../../src/shared/ics.mts"
import { spansOf } from "../../src/shared/recur.mts"
import { plainDay } from "../../src/shared/temporal.mts"
import { addDays, daysBetween } from "../../src/shared/time.mts"
import curated from "../../src/social/curated.json" with { type: "json" }
import { d1 } from "./d1.mts"

const DATA = new URL("../fixtures/data/", import.meta.url)
const json = async <T,>(path: string) => JSON.parse(await readFile(new URL(path, DATA), "utf8")) as T

const index = await json<CoursesIndex>("src/courses/courses.json")
const { events } = await json<EventsData>("src/map/events.json")
const live = index.terms[0]
const term = termOf(index, live, await json<TermFile>(`public${live.file}`))

// The Worker's clock, pinned within the fixtures' term
vi.useFakeTimers({ toFake: ["Date"] })
vi.setSystemTime(Date.parse(`${addDays(live.from, 30)}T16:00:00Z`))

/** The map page's head, naming the fixtures' data as a build's does */
const PAGE = `<html><head><meta name="release" content="2026-10-07T00:00:00Z"><link rel="data" href="/src/courses/courses.json" data-name="courses"><link rel="data" href="/src/map/events.json" data-name="events"></head></html>`

/** A Worker over the fixtures' site, with a fresh database, and a device of it */
const worker = (published = events) => {
  const env = {
    DB: d1(),
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input)
        // Other events than the fixtures' are a release of their own, as the site's files are kept by release
        if (pathname === "/src/map/events.json")
          return Response.json({ fetched: Date.now(), events: published })
        return pathname === "/map/"
          ? new Response(PAGE.replace("2026-10-07T00:00:00Z", published === events ? "original" : "merged"), { headers: { "content-type": "text/html" } })
          : readFile(new URL(pathname.startsWith("/data/") ? `public${pathname}` : pathname.slice(1), DATA)).then(body => new Response(body), () => new Response("", { status: 404 }))
      }
    }
  } as unknown as Env
  const get = (path: string) => app.fetch(new Request(`http://notunh.app${path}`), env)
  const post = (path: string, body: unknown, secret?: string) =>
    app.fetch(new Request(`http://notunh.app${path}`, { method: "POST", headers: { "content-type": "application/json", ...secret && { authorization: `Bearer ${secret}` } }, body: JSON.stringify(body) }), env)
  return { env, get, post }
}

/** A calendar file's occurrences over a term, each as its day and times on Durham's clock */
const told = async (response: Response) => {
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8")
  expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="[\w-]+\.ics"$/)
  return readEvents(await response.text()).flatMap(event =>
    spansOf(event.session, plainDay(addDays(live.from, -30)), daysBetween(live.from, live.to) + 200, event.zone).map(({ start, end }) => ({ title: event.title, where: event.where, start, end })))
}

const timed = term.sections.filter(meets)

test("a section's file says exactly the meetings its page shows over the term, swap days and days off and all", async () => {
  const { get } = worker()
  await fc.assert(fc.asyncProperty(fc.constantFrom(...timed), async section => {
    const shown = Array.from({ length: daysBetween(live.from, live.to) + 30 }, (_, i) => occurrences(term, section, index.calendar, addDays(live.from, i))).flat()
    const file = await told(await get(calendarPath("section", term.code, section.crn)))
    expect(file.map(({ start, end, where }) => [start, end, where]).sort()).toEqual(shown.map(({ start, end, where }) => [start, end, where]).sort())
  }), { numRuns: 25 })
  expect((await get(calendarPath("section", term.code, "00000"))).status).toBe(404)
  expect((await get(calendarPath("section", "209910", timed[0].crn))).status).toBe(404)
  expect((await get(`/api/calendar/section/${term.code}/${timed[0].crn}`)).status).toBe(404)
})

test("an event's file is the event, a pin's whoever has its link, and a series' every session of it", async () => {
  const { get, post } = worker()
  for (const event of events.slice(0, 20)) {
    const [one, ...rest] = await told(await get(calendarPath("event", event.id)))
    expect(rest).toEqual([])
    expect(one).toMatchObject({ title: event.title, start: Math.floor(event.start / 60_000) * 60_000, end: Math.floor(event.end / 60_000) * 60_000 })
  }
  expect((await get(calendarPath("event", "presence:no-such-event"))).status).toBe(404)
  const [start, end] = [Date.now() + 3_600_000, Date.now() + 2 * 3_600_000]
  const made = await post("/api/pins", { device: "a".repeat(16), id: "p".repeat(16), title: "Frisbee", description: "", place: "Thompson Hall", where: "the lawn", times: [{ start, end }], visibility: "link" }, "secret-of-a-device")
  expect(made.status).toBe(201)
  expect(await told(await get(calendarPath("event", "p".repeat(16))))).toEqual([{ title: "Frisbee", where: "Thompson Hall · the lawn", start: Math.floor(start / 60_000) * 60_000, end: Math.floor(end / 60_000) * 60_000 }])
  for (const series of curated) {
    const file = await told(await get(calendarPath("series", slugOf(series.title))))
    expect(file.length).toBeGreaterThan(0)
    expect(file.every(({ title, where }) => title === series.title && where === series.where)).toBe(true)
    expect(new Set(file.map(({ start }) => start)).size).toBe(file.length)
  }
  expect((await get(calendarPath("series", "no-such-series"))).status).toBe(404)
})

test("a feed is a person's saved sections and the events they host or go to, by its token alone, and no other token's", async () => {
  const { get, post } = worker()
  const [device, secret, token] = ["d".repeat(16), "secret-of-d-device", "t".repeat(22)]
  const saved = timed.slice(0, 3)
  const sync = await post("/api/state", { device, entries: {
    "courses-saved": { at: 1, by: "browser", value: saved.map(({ crn }) => `${term.code}:${crn}`) },
    "calendar-feed": { at: 1, by: "browser", value: token }
  } }, secret)
  expect(sync.status).toBe(200)
  const [start, end] = [Date.now() + 3_600_000, Date.now() + 2 * 3_600_000]
  await post("/api/pins", { device, id: "q".repeat(16), title: "Study group", description: "Bring notes", place: "Dimond Library", where: "", times: [{ start, end }], visibility: "link" }, secret)
  const response = await get(calendarPath("feed", token))
  expect(response.headers.get("cache-control")).toMatch(/^private/)
  const feed = await told(response)
  const classes = saved.flatMap(section => Array.from({ length: daysBetween(live.from, live.to) + 30 }, (_, i) => occurrences(term, section, index.calendar, addDays(live.from, i))).flat())
  expect(feed.filter(({ title }) => title !== "Study group").map(({ start, where }) => [start, where]).sort()).toEqual(classes.map(({ start, where }) => [start, where]).sort())
  expect(feed.filter(({ title }) => title === "Study group")).toHaveLength(1)
  // Any other token, well formed or not, is no calendar, and says nothing of whether one's near
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[\w-]{1,40}$/).filter(other => other !== token), async other => {
    expect((await get(calendarPath("feed", other))).status).toBe(404)
  }), { numRuns: 30 })
  // A new token ends the old address
  await post("/api/state", { device, entries: { "calendar-feed": { at: 2, by: "browser", value: "u".repeat(22) } } }, secret)
  expect((await get(calendarPath("feed", token))).status).toBe(404)
  expect((await get(calendarPath("feed", "u".repeat(22)))).status).toBe(200)
})

test("a feed has the sessions saved, each under the id it was saved by, not every session of an activity followed, which its own address has; and anyone with the address reads it, verified or not", async () => {
  const [device, secret, token] = ["s".repeat(16), "secret-of-s-device", "v".repeat(22)]
  const ahead = events.filter(event => event.end > Date.now())
  const session = ahead.find(event => seriesOf(event))!
  const key = seriesOf(session)!.key
  const sessions = ahead.filter(event => seriesOf(event)?.key === key)
  // Saved as another calendar's id told it, before the two tellings were merged
  const alias = "25live:previous"
  const { get, post } = worker(events.map(event => event === session ? { ...event, also: [alias] } : event))
  await post("/api/state", { device, entries: {
    "calendar-feed": { at: 1, by: "browser", value: token },
    "events-saved":  { at: 1, by: "browser", value: { sessions: { [alias]: session.end }, follows: [key] } }
  } }, secret)
  // Asked as a calendar app asks, with no cookie or secret
  const feedFile = await get(calendarPath("feed", token))
  expect(await feedFile.clone().text()).toContain(`UID:${alias}@notunh.app`)
  expect(await (await get(calendarPath("event", alias))).text()).toContain(`UID:${alias}@notunh.app`)
  const feed = await told(feedFile)
  expect(feed.map(({ title }) => title)).toEqual([session.title])
  const all = await told(await get(calendarPath("activity", key)))
  expect(all).toHaveLength(sessions.length)
  expect((await get(calendarPath("activity", "presence:no-such-club"))).status).toBe(404)
  // What newer code keeps, as a version this Worker doesn't read, is left out of the feed rather than misread, and
  // stays as it's kept, whatever older code writes after
  const newer = { version: 1, saved: [{ id: alias, end: session.end }] }
  await post("/api/state", { device, entries: { "events-saved": { at: 2, by: "browser", value: newer } } }, secret)
  expect(await told(await get(calendarPath("feed", token)))).toEqual([])
  const older = await post("/api/state", { device, entries: { "events-saved": { at: 3, by: "browser", value: { sessions: {}, follows: [] } } } }, secret)
  expect((await older.json() as { entries: Record<string, unknown> }).entries["events-saved"]).toEqual({ at: 2, by: "browser", value: newer })
})

//#region The one address asked for someone

test("only an https address of a public host by name is asked: never a number, a private name, a port, a credential, or this site", () => {
  for (const ok of ["https://calendar.google.com/calendar/ical/x/basic.ics", "webcal://mycourses.unh.edu/feeds/calendars/user_abc.ics", "https://outlook.office365.com/owa/calendar/x/calendar.ics", " https://example.org/a.ics "])
    expect(fetchable(ok)?.protocol, ok).toBe("https:")
  for (const not of [
    "http://calendar.google.com/a.ics", "ftp://example.org/a.ics", "file:///etc/passwd", "data:text/calendar,BEGIN:VCALENDAR", "javascript:alert(1)", "",
    "https://127.0.0.1/a.ics", "https://10.0.0.5/a.ics", "https://169.254.169.254/latest/meta-data", "https://2130706433/a.ics", "https://0x7f000001/a.ics", "https://0177.0.0.1/", "https://[::1]/a.ics", "https://[fd00::1]/a.ics",
    "https://localhost/a.ics", "https://intranet/a.ics", "https://printer.local/a.ics", "https://db.internal/a.ics", "https://thing.localhost/a.ics", "https://x.onion/a.ics",
    "https://example.org:8443/a.ics", "https://user:pass@example.org/a.ics", "https://notunh.app/api/calendar/feed/x.ics", "https://www.notunh.app/a.ics", "not an address"
  ])
    expect(fetchable(not), not).toBeUndefined()
  fc.assert(fc.property(fc.ipV4(), fc.ipV6(), fc.webUrl({ validSchemes: ["http"] }), (v4, v6, http) => {
    expect(fetchable(`https://${v4}/a.ics`)).toBeUndefined()
    expect(fetchable(`https://[${v6}]/a.ics`)).toBeUndefined()
    expect(fetchable(http)).toBeUndefined()
  }))
})

test("a calendar is handed back only where the address answers with one: redirects are checked like the first address, and anything else, too big or too far, is refused", async () => {
  const ics = await readFile(new URL("../fixtures/calendars/google.ics", import.meta.url), "utf8")
  const asked: string[] = []
  const web = (answers: Record<string, () => Response>): typeof fetch => async input => {
    asked.push(String(input))
    return answers[String(input)]?.() ?? new Response("", { status: 404 })
  }
  const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })
  expect(await calendarAt("webcal://example.org/a.ics", web({ "https://example.org/a.ics": () => new Response(ics) }))).toEqual({ ics })
  expect(await calendarAt("https://example.org/a", web({ "https://example.org/a": redirect("/b.ics"), "https://example.org/b.ics": () => new Response(ics) }))).toEqual({ ics })
  // A redirect to somewhere private is never followed
  asked.length = 0
  for (const inside of ["http://example.org/b.ics", "https://127.0.0.1/b.ics", "https://169.254.169.254/", "https://db.internal/b.ics"])
    expect(await calendarAt("https://example.org/a", web({ "https://example.org/a": redirect(inside) }))).toHaveProperty("problem")
  expect(asked.every(url => url === "https://example.org/a")).toBe(true)
  // Nor more than a few, nor a page that isn't a calendar, nor one too big, nor an address never asked at all
  expect(await calendarAt("https://example.org/a", web({ "https://example.org/a": redirect("/a") }))).toHaveProperty("problem")
  expect(await calendarAt("https://example.org/a", web({ "https://example.org/a": () => new Response("<html>Sign in</html>") }))).toHaveProperty("problem")
  expect(await calendarAt("https://example.org/a", web({ "https://example.org/a": () => new Response(`BEGIN:VCALENDAR\r\n${"X".repeat(3 * 1024 * 1024)}`) }))).toHaveProperty("problem")
  asked.length = 0
  expect(await calendarAt("https://10.0.0.1/a.ics", web({}))).toHaveProperty("problem")
  expect(asked).toEqual([])
  const { post } = worker()
  expect((await post("/api/calendar/fetch", { url: "https://127.0.0.1/a.ics" })).status).toBe(422)
  expect((await post("/api/calendar/fetch", {})).status).toBe(400)
})

//#endregion
