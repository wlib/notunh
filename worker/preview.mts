// The pages people share and search engines find: a pin's, /p/<id>, the map's, /map/event/<id>, /map/place/<name>,
// /map/section/<term>/<crn> and the rest (src/map/link.mts), and each laundry room's, /laundry/<room>/. Each is the
// built page served as what it's of (src/shell/served.tsx): a head saying its title, line, canonical address and
// structured data, a card of its own (card.mts), at /map/card/ and the page's path, with a version of what the card
// says, so a changed event is a new address, drawn on its first fetch and kept at the edge, and a summary in its body
// in place of the page's shell. The map itself, /map/, never reaches the Worker, and the service worker keeps each page
// as its own path answers it, never one of these (src/sw/worker.mts). A page of nothing in particular, like Directions,
// is the map as built; one of something there isn't, like an event gone, is the map as built answering 404, kept out
// of search; and one whose data can't be read, the map as built. Instructors' pages and pins preview as themselves,
// and are kept out of search

import { Hono } from "hono/tiny"
import type { Context } from "hono"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Page, pageOf, viewOf } from "../src/map/link.mts"
import { type Resolved, type Site, CONTEXTS, OF_SOMETHING, UNLISTED, eventResolved, resolve } from "../src/map/site.mts"
import { type Preview, describe } from "../src/social/preview.mts"
import { pinPath } from "../src/social/event.mts"
import { pathOf, roomAtSlug, roomSummary } from "../src/laundry/rooms.mts"
import { type Head, type Summary, headOf, unlisted, withHead, withSummary } from "../src/shell/served.tsx"
import { breadcrumbsOf, eventDataOf, trailTo } from "../src/shell/structured.mts"
import { NAME, SITE, imageOf } from "../src/shell/pages.mts"
import { readJson } from "../src/shared/json.mts"
import type { Env } from "./env.mts"
import { dataOf, siteBuild } from "./site.mts"
import { publicPin } from "./social.mts"
import { LOOK, render } from "./card.mts"

type Worker = { Bindings: Env }

export const previews = new Hono<Worker>()

/** Where pages' cards are, each at its page's path after this */
const CARD = "/map/card/"

/** How long the edge keeps a page, which says what's on now */
const PAGE_CACHE = "public, max-age=60"

/** How long the edge keeps a card: for good under the version its page names, else briefly */
const CARD_CACHE = { current: "public, max-age=31536000, immutable", stale: "public, max-age=600" }

//#region What a page is of

/** The site's data, as the map page served now names it, read from the Worker's own assets */
const siteOf = (env: Env): Site => ({
  named: async <T,>(name: string, schema: StandardSchemaV1<unknown, T>) => {
    const path = (await siteBuild(env.ASSETS)).data[name]
    if (!path)
      throw new Error(`The map page names no ${name}`)
    return dataOf(env.ASSETS, path, response => readJson(response, schema, path))
  },
  file: <T,>(path: string, schema: StandardSchemaV1<unknown, T>) =>
    dataOf(env.ASSETS, path, response => readJson(response, schema, path))
})

/** A page that couldn't be read, which is logged */
const UNREAD = Symbol("unread")

/** What a page is of, a pin's included, or none where it's of nothing there is, or UNREAD where its data couldn't be read */
const resolvedOf = async (env: Env, page: Page): Promise<Resolved | undefined | typeof UNREAD> => {
  try {
    const found = await resolve(siteOf(env), page, Date.now())
    if (found || page.kind !== "event")
      return found
    const pin = await publicPin(env.DB, page.id)
    return pin && eventResolved(pin)
  }
  catch (error) {
    console.error(`Couldn't resolve ${viewOf(page)}`, error)
    return UNREAD
  }
}

/** A preview's version: a hash of what its card says and how it looks */
export const versionOf = async (preview: Preview) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([LOOK, preview]))))]
    .slice(0, 6).map(byte => byte.toString(16).padStart(2, "0")).join("")

/** A page's card's address, by its view's path and the preview's version */
const cardUrl = async (page: Page, preview: Preview) =>
  `${SITE}${CARD}${viewOf(page).slice("/map/".length)}?v=${await versionOf(preview)}`

/** A page of the map's head: its own address and card, and where search may list it, an official event's structured data and the trail to it */
const mapHead = async (page: Page, { preview, event, place }: Resolved) => {
  const url = SITE + viewOf(page)
  const image = await cardUrl(page, preview)
  const isListed = !UNLISTED.includes(page.kind) && event?.source !== "pin"
  const data = isListed ? [
    ...event ? [eventDataOf({ event, place, url, image, description: describe(preview) })].filter(thing => thing !== undefined) : [],
    breadcrumbsOf(trailTo("/map/", preview.title, url))
  ] : []
  return headOf(preview, url, image, { context: CONTEXTS[page.kind], data, isListed })
}

//#endregion

/** A built page by its path, as the assets answer it */
const built = (c: Context<Worker>, path: string) =>
  c.env.ASSETS.fetch(new URL(path, c.req.url))

/** A built page with another head, and a summary in its body where there's one */
const served = async (c: Context<Worker>, path: string, head: Head, summary?: Summary) => {
  const page = await built(c, path)
  if (!page.ok)
    return page
  const html = withHead(await page.text(), head)
  return c.html(summary ? withSummary(html, summary) : html, 200, {
    "cache-control": PAGE_CACHE,
    ...!head.isListed && { "x-robots-tag": "noindex" }
  })
}

// A page's card, kept at the edge under its version for as long as that's what it says, or the map's own card for a
// page that's of nothing now
previews.get(`${CARD}*`, async c => {
  const cache = typeof caches === "undefined" ? undefined : caches.default
  const kept = await cache?.match(c.req.raw)
  if (kept)
    return kept
  const url = new URL(c.req.url)
  const page = pageOf(`/map/${url.pathname.slice(CARD.length)}`)
  const found = page && OF_SOMETHING.includes(page.kind) ? await resolvedOf(c.env, page) : undefined
  if (!page || !found || found === UNREAD)
    return c.redirect(imageOf("/map/"), 302)
  const isCurrent = url.searchParams.get("v") === await versionOf(found.preview)
  const card = new Response(await render(found.preview), {
    headers: { "content-type": "image/png", "cache-control": isCurrent ? CARD_CACHE.current : CARD_CACHE.stale }
  })
  if (cache && isCurrent)
    c.executionCtx.waitUntil(cache.put(c.req.raw, card.clone()))
  return card
})

// One of the map's pages: the map, headed and summarized as what it's of; as built for a page of nothing in particular
// or whose data couldn't be read; and for one of something there isn't, or no page at all, as built answering 404
previews.get("/map/*", async c => {
  const { pathname, search } = new URL(c.req.url)
  const page = pageOf(pathname, search)
  if (page && !OF_SOMETHING.includes(page.kind))
    return built(c, "/map/")
  const found = page && await resolvedOf(c.env, page)
  if (found === UNREAD)
    return built(c, "/map/")
  if (!page || !found) {
    const map = await built(c, "/map/")
    return c.html(unlisted(await map.text()), 404, { "cache-control": PAGE_CACHE, "x-robots-tag": "noindex" })
  }
  // An instructor's body says nothing more than their head, which is only for the link
  return served(c, "/map/", await mapHead(page, found), UNLISTED.includes(page.kind) ? undefined : found)
})

// A pin's own page, with the pin in its head, kept out of search, and the page as built for a pin gone or hidden,
// which it says
previews.get("/p/:id", async c => {
  const page: Page = { kind: "event", id: c.req.param("id") }
  const pin = await publicPin(c.env.DB, page.id)
  if (!pin)
    return built(c, "/p/").then(page => new Response(page.body, { status: 404, headers: page.headers }))
  const { preview } = eventResolved(pin)
  return served(c, "/p/", headOf(preview, SITE + pinPath(pin.id), await cardUrl(page, preview), { context: CONTEXTS.event, isListed: false }))
})

// A laundry room's own address: the laundry page, which opens that room, headed and summarized as the room
previews.get("/laundry/:room/", async c => {
  const room = roomAtSlug(c.req.param("room"))
  if (!room)
    return c.notFound()
  const url = SITE + pathOf(room.id)
  const summary = roomSummary(room)
  const head = headOf(summary.preview, url, SITE + imageOf("/laundry/"), {
    title: `${room.name} laundry: free washers & dryers · ${NAME}`,
    data:  [breadcrumbsOf(trailTo("/laundry/", summary.preview.title, url))]
  })
  return served(c, "/laundry/", head, summary)
})
