// Link previews of the pages people share: a pin's, /p/<id>, and the map's, /map/event/<id>, /map/place/<name>,
// /map/section/<term>/<crn> and the rest (src/map/link.mts). Each is the built page with a head saying what it's of
// (src/social/preview.mts) and a card of its own (card.mts), at /map/card/ and the page's path, with a version of what
// the card says, so a changed event is a new address, drawn on its first fetch and kept at the edge. The map itself,
// /map/, never reaches the Worker. The service worker keeps the map as its own path answers it, never a page's
// (src/sw/worker.mts). Anything that doesn't resolve, an unknown id or an event gone, is the page as built

import { Hono } from "hono/tiny"
import type { Context } from "hono"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Page, pageOf, viewOf } from "../src/map/link.mts"
import { type Preview, areaPreview, coursePreview, describe, eventPreview, parkingPreview, personPreview, placePreview, programPreview, roomPreview, sectionPreview, stopPreview } from "../src/social/preview.mts"
import { EventsData, pinPath } from "../src/social/event.mts"
import { Gazetteer } from "../src/places/gazetteer.mts"
import { CoursesIndex, TermFile, activeTerms, termOf } from "../src/courses/course.mts"
import { createPeople } from "../src/courses/people.mts"
import { roomKey } from "../src/courses/rooms.mts"
import { PrereqsIndex } from "../src/programs/prereqs.mts"
import { Program, Programs } from "../src/programs/program.mts"
import { ParkingData } from "../src/parking/sources.mts"
import { FeedData } from "../src/transit/feed.mts"
import { IMAGE, NAME, SITE, imageOf } from "../src/shell/pages.mts"
import { readJson } from "../src/shared/json.mts"
import type { Env } from "./env.mts"
import { dataOf, siteBuild } from "./site.mts"
import { publicPin } from "./social.mts"
import { LOOK, render } from "./card.mts"

type Worker = { Bindings: Env }

export const previews = new Hono<Worker>()

/** The kinds of the map's pages that preview as what they're of; the rest preview as the map */
const SHOWN: readonly Page["kind"][] = ["event", "place", "section", "course", "person", "room", "program", "parking", "area", "stop"]

/** Where pages' cards are, each at its page's path after this */
const CARD = "/map/card/"

//#region The head

const escaped = (text: string) =>
  text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!)

/** What a page's head says of a preview: its title and line, its own link, and its card's */
export type Head = { title: string, description: string, url: string, image: string }

/** A page's head from its preview, its link, and its card's */
export const headOf = (preview: Preview, url: string, image: string): Head =>
  ({ title: `${preview.title} · ${NAME}`, description: describe(preview), url, image })

/**
 * A built page's HTML with a preview's head in place of its own: its title, and every meta that previews and search
 * engines read of it that the page has, escaped, with nothing else changed
 */
export const withHead = (html: string, { title, description, url, image }: Head) => {
  const alt = `${title}: ${description}`
  const named: Record<string, string> = {
    "description": description,
    "og:title": title, "twitter:title": title,
    "og:description": description, "twitter:description": description,
    "og:url": url,
    "og:image": image, "twitter:image": image,
    "og:image:alt": alt, "twitter:image:alt": alt,
    "og:image:width": `${IMAGE.width}`, "og:image:height": `${IMAGE.height}`
  }
  const [head, ...body] = html.split("</head>")
  return [
    head
      .replace(/<title>[^<]*<\/title>/, () => `<title>${escaped(title)}</title>`)
      .replace(/<meta (name|property)="([^"]+)" content="[^"]*"/g, (tag, attribute: string, name: string) => name in named ? `<meta ${attribute}="${name}" content="${escaped(named[name])}"` : tag),
    ...body
  ].join("</head>")
}

//#endregion

//#region What a page is of

/** A data file the map page names, as a schema makes it */
const named = async <T,>(env: Env, name: string, schema: StandardSchemaV1<unknown, T>) => {
  const path = (await siteBuild(env.ASSETS)).data[name]
  if (!path)
    throw new Error(`The map page names no ${name}`)
  return dataOf(env.ASSETS, path, response => readJson(response, schema, path))
}

/** A data file by its own path, as an index names it */
const file = <T,>(env: Env, path: string, schema: StandardSchemaV1<unknown, T>) =>
  dataOf(env.ASSETS, path, response => readJson(response, schema, path))

/** The terms of the courses index, all of them or those live at an instant, with their sections */
const termsOf = async (env: Env, which: "all" | number) => {
  const index = await named(env, "courses", CoursesIndex)
  const entries = which === "all" ? index.terms : activeTerms(index.terms, which)
  return Promise.all(entries.map(async entry => termOf(index, entry, await file(env, entry.file, TermFile))))
}

/** A page's preview from the site's data and the pins, at an instant, or none for a page naming nothing there is */
export const previewOf = async (env: Env, page: Page, now: number): Promise<Preview | undefined> => {
  switch (page.kind) {
    case "event": {
      // A pin is still found while the build's events can't be read
      const built = await named(env, "events", EventsData).then(({ events }) => events.find(({ id }) => id === page.id), () => undefined)
      const event = built ?? await publicPin(env.DB, page.id)
      return event && eventPreview(event)
    }
    case "place": {
      const [{ places }, { events }] = await Promise.all([named(env, "gazetteer", Gazetteer), named(env, "events", EventsData)])
      const place = places.find(({ name }) => name === page.name)
      return place && placePreview(place, events, now)
    }
    case "section": {
      const index = await named(env, "courses", CoursesIndex)
      const entry = index.terms.find(({ code }) => code === page.term)
      const term = entry && termOf(index, entry, await file(env, entry.file, TermFile))
      const section = term?.sections.find(({ crn }) => crn === page.crn)
      return section && sectionPreview(term!, section)
    }
    case "course":
      return coursePreview(page.code, await termsOf(env, "all"))
    case "person": {
      const person = createPeople(await termsOf(env, now)).find(({ id }) => id === page.id)
      return person && personPreview(person)
    }
    case "room":
      return roomPreview(page.where, await termsOf(env, now), where => roomKey(where) === roomKey(page.where))
    case "program": {
      const index = await named(env, "prereqs", PrereqsIndex)
      const listed = index.programs ? (await file(env, index.programs, Programs)).programs.find(({ slug }) => slug === page.slug) : undefined
      return listed && programPreview(listed, (await file(env, listed.file, Program)).courses.length, index.year ?? "")
    }
    case "parking": {
      const { places } = await named(env, "gazetteer", Gazetteer)
      return !page.place || places.some(({ name }) => name === page.place) ? parkingPreview(page.place) : undefined
    }
    case "area": {
      const area = (await named(env, "parking", ParkingData)).areas.find(({ id }) => id === page.id)
      return area && areaPreview(area)
    }
    case "stop":
      return stopPreview(await named(env, "gtfs", FeedData), page.id)
  }
}

/** A preview's version: a hash of what its card says and how it looks */
export const versionOf = async (preview: Preview) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([LOOK, preview]))))]
    .slice(0, 6).map(byte => byte.toString(16).padStart(2, "0")).join("")

/** A page's card's address, by its view's path and the preview's version */
const cardUrl = async (page: Page, preview: Preview) =>
  `${SITE}${CARD}${viewOf(page).slice("/map/".length)}?v=${await versionOf(preview)}`

/** What a page is of, or none where it's of nothing there is, or that couldn't be read, which is logged */
const resolved = (env: Env, page: Page | undefined) =>
  page && SHOWN.includes(page.kind)
    ? previewOf(env, page, Date.now()).catch(error => void console.error(`Couldn't preview ${viewOf(page)}`, error))
    : Promise.resolve(undefined)

/** A built page with a preview's head */
const headed = async (c: Context<Worker>, path: string, head: Head) => {
  const page = await c.env.ASSETS.fetch(new URL(path, c.req.url))
  return page.ok ? c.html(withHead(await page.text(), head), 200, { "cache-control": "public, max-age=60" }) : page
}

//#endregion

// A page's card, kept at the edge under its version for as long as that's what it says, or the map's own card for a
// page that's of nothing now
previews.get(`${CARD}*`, async c => {
  const cache = typeof caches === "undefined" ? undefined : caches.default
  const kept = await cache?.match(c.req.raw)
  if (kept)
    return kept
  const url = new URL(c.req.url)
  const page = pageOf(`/map/${url.pathname.slice(CARD.length)}`)
  const preview = await resolved(c.env, page)
  if (!page || !preview)
    return c.redirect(imageOf("/map/"), 302)
  const isCurrent = url.searchParams.get("v") === await versionOf(preview)
  const card = new Response(await render(preview), {
    headers: { "content-type": "image/png", "cache-control": isCurrent ? "public, max-age=31536000, immutable" : "public, max-age=600" }
  })
  if (cache && isCurrent)
    c.executionCtx.waitUntil(cache.put(c.req.raw, card.clone()))
  return card
})

// One of the map's pages: the map with that page's head, or as built for one that's of nothing to preview
previews.get("/map/*", async c => {
  const { pathname, search } = new URL(c.req.url)
  const page = pageOf(pathname, search)
  const preview = await resolved(c.env, page)
  if (!page || !preview)
    return c.env.ASSETS.fetch(new URL("/map/", c.req.url))
  return headed(c, "/map/", headOf(preview, SITE + viewOf(page), await cardUrl(page, preview)))
})

// A pin's own page, with the pin in its head, and the page as built for a pin gone or hidden, which it says
previews.get("/p/:id", async c => {
  const page: Page = { kind: "event", id: c.req.param("id") }
  const pin = await publicPin(c.env.DB, page.id)
  if (!pin)
    return c.env.ASSETS.fetch(new URL("/p/", c.req.url)).then(built => new Response(built.body, { status: 404, headers: built.headers }))
  const preview = eventPreview(pin)
  return headed(c, "/p/", headOf(preview, SITE + pinPath(pin.id), await cardUrl(page, preview)))
})
