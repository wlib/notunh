// The pages people share and search engines find: a pin's, /p/<id>, the map's, /map/event/<id>, /map/place/<name>,
// /map/section/<term>/<crn> and the rest (src/map/link.mts), and each laundry room's, /laundry/<room>/. Each is the
// built page with a head saying what it's of (src/social/preview.mts): its title, line, canonical address, structured
// data, and a card of its own (card.mts), at /map/card/ and the page's path, with a version of what the card says, so a
// changed event is a new address, drawn on its first fetch and kept at the edge. Its body says it too, in place of the
// page's shell (src/shell/summary.mts), which the app replaces whole as it loads. The map itself, /map/, never reaches
// the Worker, and the service worker keeps each page as its own path answers it, never one of these (src/sw/worker.mts).
// A page of nothing in particular, like Directions, is the map as built; one of something there isn't, like an event
// gone, is the map as built answering 404, kept out of search; and one whose data can't be read, the map as built.
// Instructors' pages and pins preview as themselves, and are kept out of search

import { Hono } from "hono/tiny"
import type { Context } from "hono"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Thing, WithContext } from "schema-dts"
import { type Page, pageOf, viewOf } from "../src/map/link.mts"
import { type Resolved, type Site, OF_SOMETHING, UNLISTED, eventResolved, resolve } from "../src/map/site.mts"
import { type Preview, describe } from "../src/social/preview.mts"
import { pinPath } from "../src/social/event.mts"
import { pathOf, roomAtSlug } from "../src/laundry/rooms.mts"
import { escaped, summaryHtml, type Summary } from "../src/shell/summary.mts"
import { breadcrumbsOf, eventDataOf } from "../src/shell/structured.mts"
import { IMAGE, NAME, SITE, imageOf, scriptJson, trailTo } from "../src/shell/pages.mts"
import { readJson } from "../src/shared/json.mts"
import type { Env } from "./env.mts"
import { dataOf, siteBuild } from "./site.mts"
import { publicPin } from "./social.mts"
import { LOOK, render } from "./card.mts"

type Worker = { Bindings: Env }

export const previews = new Hono<Worker>()

/** Where pages' cards are, each at its page's path after this */
const CARD = "/map/card/"

/** What a title adds to say it's of UNH, by the kind of page, unless it says so already */
const CONTEXTS: Partial<Record<Page["kind"], string>> = {
  event: "UNH event", place: "UNH map", section: "UNH class", course: "UNH course", person: "UNH", room: "UNH classroom",
  program: "UNH catalog", parking: "UNH parking", area: "UNH parking", stop: "UNH bus stop"
}

//#region The page

/** What a page's head says of it: its title and line, its own address and its card's, its structured data, and whether search may list it */
export type Head = { title: string, description: string, url: string, image: string, data: WithContext<Thing>[], isListed: boolean }

/** A page's head from its preview, its address and its card's, with what its title adds, unless the title has it */
export const headOf = (preview: Preview, url: string, image: string, { context, data = [], isListed = true }: { context?: string, data?: WithContext<Thing>[], isListed?: boolean } = {}): Head => ({
  title:       [preview.title, context && !preview.title.includes("UNH") ? context : "", NAME].filter(Boolean).join(" · "),
  description: describe(preview),
  url,
  image,
  data,
  isListed
})

/** Kept out of search engines' results, in a page's head */
const NOINDEX = `<meta name="robots" content="noindex">`

/**
 * A built page's HTML with another head's words in place of its own: its title, every meta that previews and search
 * engines read that the page has, its canonical address and its structured data, escaped, and kept out of search
 * where it's not to be listed, with nothing else changed
 */
export const withHead = (html: string, { title, description, url, image, data, isListed }: Head) => {
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
      .replace(/<meta (name|property)="([^"]+)" content="[^"]*"/g, (tag, attribute: string, name: string) => name in named ? `<meta ${attribute}="${name}" content="${escaped(named[name])}"` : tag)
      .replace(/<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${escaped(url)}">`)
      // scriptJson escapes every "<", so the script's JSON holds none
      .replace(/<script type="application\/ld\+json">[^<]*<\/script>/, () => data.length ? `<script type="application/ld+json">${scriptJson(data)}</script>` : "")
      + (isListed ? "" : NOINDEX),
    ...body
  ].join("</head>")
}

/** A built page's HTML kept out of search, as a page of nothing there is is */
export const unlisted = (html: string) =>
  html.replace("</head>", `${NOINDEX}</head>`)

/**
 * A built page's HTML saying a summary in its body: in place of its shell, the first <section class="shell">, with the
 * app's title no longer the page's heading, which the summary's title is. The app replaces both as it loads
 */
export const withBody = (html: string, summary: Summary) => {
  const body = Math.max(0, html.indexOf("<body"))
  return html.slice(0, body) + html.slice(body)
    .replace(/<h1 class="app-title">([\s\S]*?)<\/h1>/, (_, title: string) => `<p class="app-title">${title}</p>`)
    .replace(/<section class="shell">[\s\S]*?<\/section>/, () => summaryHtml(summary))
}

//#endregion

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

/** A page of the map's head: an official event's structured data, and the trail to it */
const mapHead = async (page: Page, { preview, event, place }: Resolved) => {
  const url = SITE + viewOf(page)
  const image = await cardUrl(page, preview)
  const isListed = !UNLISTED.includes(page.kind) && event?.source !== "pin"
  // A page kept out of search says nothing for it
  const data = isListed ? [
    ...event ? [eventDataOf({ event, place, url, image, description: describe(preview) })].filter(thing => thing !== undefined) : [],
    breadcrumbsOf(trailTo("/map/", preview.title, url))
  ] : []
  return headOf(preview, url, image, { context: CONTEXTS[page.kind], data, isListed })
}

/** A built page by its path, as the assets answer it */
const built = (c: Context<Worker>, path: string) =>
  c.env.ASSETS.fetch(new URL(path, c.req.url))

/** A built page with another head, and a summary in its body where there's one, answered with a status */
const headed = async (c: Context<Worker>, path: string, head: Head, summary?: Summary) => {
  const page = await built(c, path)
  if (!page.ok)
    return page
  const html = withHead(await page.text(), head)
  return c.html(summary ? withBody(html, summary) : html, 200, {
    "cache-control": "public, max-age=60",
    ...!head.isListed && { "x-robots-tag": "noindex" }
  })
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
  const found = page && OF_SOMETHING.includes(page.kind) ? await resolvedOf(c.env, page) : undefined
  if (!page || !found || found === UNREAD)
    return c.redirect(imageOf("/map/"), 302)
  const isCurrent = url.searchParams.get("v") === await versionOf(found.preview)
  const card = new Response(await render(found.preview), {
    headers: { "content-type": "image/png", "cache-control": isCurrent ? "public, max-age=31536000, immutable" : "public, max-age=600" }
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
    return c.html(unlisted(await map.text()), 404, { "cache-control": "public, max-age=60", "x-robots-tag": "noindex" })
  }
  // An instructor's body says nothing more than their head, which is only for the link
  const head = await mapHead(page, found)
  return headed(c, "/map/", head, UNLISTED.includes(page.kind) ? undefined : { ...found.preview, parts: found.parts })
})

// A pin's own page, with the pin in its head, kept out of search, and the page as built for a pin gone or hidden,
// which it says
previews.get("/p/:id", async c => {
  const page: Page = { kind: "event", id: c.req.param("id") }
  const pin = await publicPin(c.env.DB, page.id)
  if (!pin)
    return built(c, "/p/").then(page => new Response(page.body, { status: 404, headers: page.headers }))
  const { preview } = eventResolved(pin)
  return headed(c, "/p/", headOf(preview, SITE + pinPath(pin.id), await cardUrl(page, preview), { context: CONTEXTS.event, isListed: false }))
})

// A laundry room's own address: the laundry page, which opens that room, headed and summarized as the room
previews.get("/laundry/:room/", async c => {
  const room = roomAtSlug(c.req.param("room"))
  if (!room)
    return c.notFound()
  const url = SITE + pathOf(room.id)
  const preview: Preview = {
    kind:  "Laundry room",
    title: `${room.name} laundry`,
    lines: [`Which washers and dryers are free in ${room.name} at UNH now, and how long the rest have left`]
  }
  const head: Head = {
    ...headOf(preview, url, SITE + imageOf("/laundry/")),
    title: `${room.name} laundry: free washers & dryers · ${NAME}`,
    data:  [breadcrumbsOf(trailTo("/laundry/", preview.title, url))]
  }
  return headed(c, "/laundry/", head, {
    ...preview,
    parts: [{ heading: "Getting there", items: [{ text: `Directions to ${room.name}`, href: `/map/?to=laundry/${c.req.param("room")}` }] }]
  })
})
