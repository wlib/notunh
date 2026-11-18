// Calendar files (src/shared/ics.mts), for a calendar app to add or subscribe to: an event's, a curated series', a
// section's, and a person's feed of the sections they've saved, the events they're hosting or going to, and the
// sessions they've saved, and their saved sections' finals where they hold a verified UNH address; and an activity's
// every session. Each is made as it's asked for from the site's own data, so one subscribed to follows a room change. The first three say only what their pages do. A feed is asked for by a token
// alone, 128 random bits kept as one of the person's things (FEED in src/shared/sync.mts), which whoever holds can read
// their classes by, and which they make anew to end; no device's secret is in it, and an unknown token is a 404 like
// any other
//
// And the one request the Worker makes for someone's own calendar: a feed's address that their browser can't read
// for want of CORS, as Canvas', Google's and Outlook's can't be, fetched here and handed straight back. The address
// holds a secret of theirs, so it comes in the body, and neither it nor what it answers is kept, cached or logged.
// Only an https address of a public host by name is asked, on the default port, with no credentials, following a
// few redirects each checked the same, for a file no bigger than a calendar is that starts as one
//
// That guard is on the address, which is all a Worker sees. It can't resolve a name, so it can't tell a public name
// that points at a private address, or one that will by the time it's asked. What it leans on for those is where it
// runs: Cloudflare gives a Worker's fetch no loopback, no metadata address and no private network unless one is
// bound, and none is. Under `wrangler dev` or the tests' Node server such a name would be reached

import { Hono } from "hono/tiny"
import type { Context } from "hono"
import { sValidator } from "@hono/standard-validator"
import * as v from "valibot"
import curated from "../src/social/curated.json"
import { Curated, entriesOf as seriesEntries, slugOf } from "../src/social/curated.mts"
import { entryOf } from "../src/social/calendar.mts"
import { EventsData, LINGER, eventById } from "../src/social/event.mts"
import { SAVES, readSaves, savedId } from "../src/social/saves.mts"
import { seriesOf } from "../src/social/series.mts"
import { CoursesIndex, TermFile, codeOf, termOf } from "../src/courses/course.mts"
import { entriesOf as sectionEntries } from "../src/courses/ics.mts"
import { SAVED, readSaved, savedIn } from "../src/courses/saved.mts"
import { entryOfFinal, finalsOf } from "../src/courses/finals.mts"
import { notOver, termsOf } from "../src/map/site.mts"
import { writeCalendar } from "../src/shared/ics.mts"
import { describeIssues } from "../src/shared/json.mts"
import { FeedToken } from "../src/shared/sync.mts"
import type { Env } from "./env.mts"
import { siteOf } from "./site.mts"
import { isVerifiedPerson, kept, limited, personOfFeed, pinsOf, publicPin } from "./social.mts"
import { storedFinals } from "./finals.mts"

type Worker = { Bindings: Env }

export const calendars = new Hono<Worker>()

/** How often a calendar app is asked to read a file it's subscribed to again */
const REFRESH = "PT6H"

/** How long a file anyone may read is kept at the edge, and a person's feed by their calendar app alone */
const CACHE = { shared: "public, max-age=300", feed: "private, max-age=300" }

/** A calendar file as answered: shown by the browser where it can, as iOS offers to add it, under a name of its own */
const served = (c: Context<Worker>, name: string, ics: string, cache: string) =>
  c.body(ics, 200, {
    "content-type":        "text/calendar; charset=utf-8",
    "content-disposition": `inline; filename="${slugOf(name) || "calendar"}.ics"`,
    "cache-control":       cache,
    "x-robots-tag":        "noindex"
  })

/** No such calendar, said as text, as a calendar app shows it */
const missing = (c: Context<Worker>) =>
  c.text("No such calendar", 404, { "cache-control": "no-store" })

/** What a path's last part names, without the .ics every calendar file ends in, or none for any other */
const named = (file: string) =>
  file.match(/^(.+)\.ics$/)?.[1]

// One event: UNH's as the site lists it, else a person's, which whoever has its link may read
calendars.get("/api/calendar/event/:file", async c => {
  const id = named(c.req.param("file"))
  const event = id && (eventById((await siteOf(c.env).named("events", EventsData)).events, id) ?? await publicPin(c.env.DB, id))
  return event ? served(c, event.title, writeCalendar(event.title, [entryOf({ ...event, id })], Date.now()), CACHE.shared) : missing(c)
})

// A curated series, every session of it, by its title's slug
calendars.get("/api/calendar/series/:file", c => {
  const series = v.parse(Curated, curated).find(({ title }) => slugOf(title) === named(c.req.param("file")))
  return series ? served(c, series.title, writeCalendar(series.title, seriesEntries(series), Date.now(), REFRESH), CACHE.shared) : missing(c)
})

// A section's meetings, as the academic calendar has them meet
calendars.get("/api/calendar/section/:term/:file", async c => {
  const site = siteOf(c.env)
  const index = await site.named("courses", CoursesIndex)
  const entry = index.terms.find(({ code }) => code === c.req.param("term"))
  const term = entry && termOf(index, entry, await site.file(entry.file, TermFile))
  const section = term?.sections.find(({ crn }) => crn === named(c.req.param("file")))
  const name = section && `${codeOf(section)} · ${term!.name}`
  return name ? served(c, name, writeCalendar(name, sectionEntries(term!, section, index.calendar), Date.now(), REFRESH), CACHE.shared) : missing(c)
})

// An activity, every session of it listed, by its series' key (src/social/series.mts), for whoever follows it and
// wants them all
calendars.get("/api/calendar/activity/:file", async c => {
  const key = named(c.req.param("file"))
  const sessions = key ? (await siteOf(c.env).named("events", EventsData)).events.filter(event => event.end + LINGER > Date.now() && seriesOf(event)?.key === key) : []
  const name = sessions[0] && seriesOf(sessions[0])?.name
  return name ? served(c, name, writeCalendar(name, sessions.map(entryOf), Date.now(), REFRESH), CACHE.shared) : missing(c)
})

// A person's feed, by its token: the sections they've saved in the terms not over, with their finals where the person
// holds a verified UNH address, as only they may be told them, the events they host or are going to, and the sessions
// of UNH's events they've saved, each under the id it was saved by, so one merged with another calendar's telling keeps
// its place in a calendar app. An activity followed isn't in it, as its own address has every session. Made of the
// public events and pins alone, never of bookings, as whoever holds the address reads it
calendars.get("/api/calendar/feed/:file", async c => {
  const token = named(c.req.param("file"))
  const person = token && v.is(FeedToken, token) ? await personOfFeed(c.env.DB, token) : undefined
  if (!person)
    return missing(c)
  const now = Date.now()
  const site = siteOf(c.env)
  const [terms, { calendar }, saved, pins, saves, { events }, finals] = await Promise.all([
    termsOf(site, notOver(now)), site.named("courses", CoursesIndex), kept(c.env.DB, person, SAVED), pinsOf(c.env.DB, person, now),
    kept(c.env.DB, person, SAVES).then(readSaves), site.named("events", EventsData),
    isVerifiedPerson(c.env.DB, person, now).then(isVerified => isVerified ? storedFinals(c.env.DB) : undefined)
  ])
  const classes = savedIn(readSaved(saved), terms).flatMap(({ term, section }) => [
    ...sectionEntries(term, section, calendar),
    ...finalsOf(finals?.terms[term.code]?.finals, section).map((final, i) => entryOfFinal(term, section, final, i))
  ])
  const sessions = events.flatMap(event => {
    const id = event.end + LINGER > now ? savedId(saves, event) : undefined
    return id ? [entryOf({ ...event, id })] : []
  })
  return served(c, "notunh", writeCalendar("notunh", [...classes, ...pins.map(entryOf), ...sessions], now, REFRESH), CACHE.feed)
})

//#region Someone's own calendar, fetched for them

/** The most a calendar may be, in bytes, how long it may take, and how many redirects are followed to it */
const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 10_000
const REDIRECTS = 3

/** Names that are nowhere public: single labels, the reserved endings, and this site's own */
const NOT_PUBLIC = /^[^.]+$|\.(local|localhost|internal|intranet|lan|home|corp|arpa|test|example|invalid|onion)$|(^|\.)notunh\.app$/

/**
 * An address the Worker will ask for someone: https, or webcal as calendars write it, on the default port, with no
 * credentials, of a host by a public name. Never a number, which an IP address in any spelling is once the address
 * is parsed: decimal, hex and short forms all come back as four numbers, and IPv6 in brackets
 */
export const fetchable = (address: string): URL | undefined => {
  const url = URL.parse(address.trim().replace(/^webcals?:/i, "https:"))
  const host = url?.hostname.toLowerCase().replace(/\.$/, "") ?? ""
  const isNamed = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+$/.test(host) && !NOT_PUBLIC.test(host)
  return url && url.protocol === "https:" && !url.port && !url.username && !url.password && isNamed ? url : undefined
}

/** A response's text, or none once it's more than a calendar may be */
const textWithin = async (response: Response, max: number) => {
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  for await (const chunk of response.body ?? []) {
    if ((size += chunk.length) > max)
      return
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/** A calendar at an address, as text, or why not, in words the page shows; nothing of it is logged */
export const calendarAt = async (address: string, ask: typeof fetch = fetch): Promise<{ ics: string } | { problem: string }> => {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  try {
    let url = fetchable(address)
    for (let hops = 0; url; hops++) {
      const response = await ask(url.href, { redirect: "manual", signal, headers: { accept: "text/calendar, text/plain;q=0.5", "user-agent": "notunh/1 (+https://notunh.app)" } })
      const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null
      if (next === null) {
        const ics = response.ok ? await textWithin(response, MAX_BYTES) : undefined
        return ics && /^﻿?\s*BEGIN:VCALENDAR/i.test(ics) ? { ics } : { problem: "That address didn't answer with a calendar" }
      }
      void response.body?.cancel()
      url = hops < REDIRECTS ? fetchable(new URL(next, url).href) : undefined
    }
    return { problem: "That isn't an address notunh can read a calendar from" }
  }
  catch {
    return { problem: "That calendar couldn't be reached" }
  }
}

calendars.post("/api/calendar/fetch", limited, sValidator("json", v.object({ url: v.pipe(v.string(), v.maxLength(2048)) }), (result, c) => result.success ? undefined : c.text(describeIssues(result.error), 400)), async c => {
  const found = await calendarAt(c.req.valid("json").url)
  return "ics" in found
    ? c.body(found.ics, 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
    : c.text(found.problem, 422, { "cache-control": "no-store" })
})

//#endregion
