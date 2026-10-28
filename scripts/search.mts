// What a build adds beside its pages for search engines (npm's postbuild): IndexNow's key file, and the sitemap of every
// page worth finding: the home, map, dining and laundry pages, each laundry room's, and the map's pages that
// src/map/listed.mts lists, as of the build. A page's lastmod is when what it says last changed. Each page has a
// fingerprint, a hash of what it says: a static page's HTML without when it was built, what a map page's head and
// card say, a room's name. /sitemap.json keeps each page's fingerprint and lastmod beside the sitemap, and a page keeps
// the lastmod the site serves for it while its fingerprint is the same, else takes this build's release. So a nightly
// build moves the dining page's for its new menus and a new event's, and leaves a stop's alone. Offline, as pull
// requests are built, nothing is compared and every page is this build's. Over 50,000 pages, /sitemap.xml is an
// index of sitemaps of 50,000 each, under /sitemaps/

import { mkdir, readFile, writeFile } from "node:fs/promises"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import * as v from "valibot"
import { jsx } from "bruh/server"
import { buildOf } from "../src/shell/manifest.mts"
import { INDEXNOW_KEY, PATHS, SITE } from "../src/shell/pages.mts"
import { type Site, resolve } from "../src/map/site.mts"
import { listedPages } from "../src/map/listed.mts"
import { urlOf } from "../src/map/link.mts"
import { ROOMS, pathOf } from "../src/laundry/rooms.mts"
import { contentHash } from "../src/shared/hash.mts"
import { getOrCreate } from "../src/shared/group.mts"
import { readJson } from "../src/shared/json.mts"
import { isOffline } from "./files.mts"
import { ORIGIN, served } from "./site.mts"

export const DIST = new URL("../dist/", import.meta.url)

/** How many pages a sitemap may list (https://www.sitemaps.org/protocol.html) */
export const SITEMAP_LIMIT = 50_000

/** A page listed, by its address, with a hash of what it says */
export type Listed = { loc: string, fingerprint: string }

/** A page in the sitemap, by its address, with when it last changed */
export type Entry = { loc: string, lastmod: string }

/** What /sitemap.json keeps of each page in the sitemap, by its address: its fingerprint, and when it last changed */
export const Fingerprints = v.record(v.string(), v.tuple([v.string(), v.string()]))
export type Fingerprints = v.InferOutput<typeof Fingerprints>

/** A page as it reads, without when it was built or republished, which change with every build */
export const contentOf = (html: string) =>
  html.replace(/<meta name="(release|published)" content="[^"]*">/g, "")

/** A hash of what something says */
export const fingerprint = (said: unknown) =>
  contentHash(typeof said === "string" ? said : JSON.stringify(said), "base64url").then(hash => hash.slice(0, 16))

/** When each page listed last changed: when the site says, while it says the same, else at this build's release */
export const entriesOf = (listed: readonly Listed[], served: Fingerprints, release: string): Entry[] =>
  listed.map(({ loc, fingerprint }) => ({ loc, lastmod: served[loc]?.[0] === fingerprint ? served[loc][1] : release }))

/** The fingerprints to keep beside a sitemap */
export const fingerprintsOf = (listed: readonly Listed[], entries: readonly Entry[]): Fingerprints =>
  Object.fromEntries(listed.map(({ loc, fingerprint }, index) => [loc, [fingerprint, entries[index].lastmod]]))

//#region The sitemap's XML

const PROLOG = `<?xml version="1.0" encoding="UTF-8"?>`
const NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9"

/**
 * A sitemap document of a root element's children, rendered and escaped by bruh as its HTML is, which is XML's too.
 * bruh types the attributes of HTML, SVG and MathML alone, so the sitemap's elements and namespace go untyped
 */
const sitemapXml = (root: string, children: unknown[]) =>
  `${PROLOG}\n${jsx(root, { ...{ xmlns: NAMESPACE } as {}, children: children as never })}\n`

/** A page's or a sitemap's entry: its address, and when it last changed */
const entry = (element: string, { loc, lastmod }: Entry) =>
  jsx(element, { children: [jsx("loc", { children: loc }), jsx("lastmod", { children: lastmod })] })

/** A sitemap of pages and when each last changed */
export const sitemapOf = (entries: readonly Entry[]) =>
  sitemapXml("urlset", entries.map(page => entry("url", page)))

/**
 * The files a sitemap of pages is, by their paths: /sitemap.xml alone up to the limit, else an index of sitemaps at
 * /sitemaps/<n>.xml, each changed when the latest of its pages did
 */
export const sitemapsOf = (entries: readonly Entry[], limit = SITEMAP_LIMIT): Record<string, string> => {
  if (entries.length <= limit)
    return { "/sitemap.xml": sitemapOf(entries) }
  const parts = Array.from({ length: Math.ceil(entries.length / limit) }, (_, index) => entries.slice(index * limit, (index + 1) * limit))
  const partPath = (index: number) => `/sitemaps/${index + 1}.xml`
  return {
    "/sitemap.xml": sitemapXml("sitemapindex", parts.map((part, index) => entry("sitemap", { loc: SITE + partPath(index), lastmod: part.map(({ lastmod }) => lastmod).sort().at(-1)! }))),
    ...Object.fromEntries(parts.map((part, index) => [partPath(index), sitemapOf(part)]))
  }
}

//#endregion

/** The site's data as a build in a folder has it, each file read once */
export const siteIn = async (dist: URL): Promise<Site> => {
  const { data } = buildOf(await readFile(new URL("map/index.html", dist), "utf8"))
  const read = new Map<string, Promise<unknown>>()
  const file = <T,>(path: string, schema: StandardSchemaV1<unknown, T>) =>
    getOrCreate(read, path, () => readFile(new URL(`.${path}`, dist)).then(bytes => readJson(new Response(bytes), schema, path))) as Promise<T>
  return {
    file,
    named: <T,>(name: string, schema: StandardSchemaV1<unknown, T>) =>
      data[name] ? file(data[name], schema) : Promise.reject(new Error(`The map page names no ${name}`))
  }
}

/** Every page of a build worth finding, at an instant, with its fingerprint */
export const listedIn = async (dist: URL, now: number): Promise<Listed[]> => {
  const site = await siteIn(dist)
  const pages = await Promise.all(PATHS.map(async path =>
    ({ loc: SITE + path, fingerprint: await fingerprint(contentOf(await readFile(new URL(`.${path}index.html`, dist), "utf8"))) })
  ))
  const rooms = await Promise.all(ROOMS.map(async room => ({ loc: SITE + pathOf(room.id), fingerprint: await fingerprint(room.name) })))
  // Each of the map's, as its head and card say it, which a page listed always resolves to
  const map = await Promise.all((await listedPages(site, now)).map(async page => {
    const found = await resolve(site, page, now)
    if (!found)
      throw new Error(`${urlOf(page)} is listed, but of nothing`)
    return { loc: SITE + urlOf(page), fingerprint: await fingerprint(found.preview) }
  }))
  return [...pages, ...rooms, ...map]
}

const write = async (path: string, data: string | Uint8Array) => {
  const file = new URL(`.${path}`, DIST)
  await mkdir(new URL(".", file), { recursive: true })
  await writeFile(file, data)
}

if (import.meta.main) {
  const { release } = buildOf(await readFile(new URL("index.html", DIST), "utf8"))
  const listed = await listedIn(DIST, Date.now())
  const kept = isOffline ? undefined : await served("/sitemap.json", Fingerprints)
  const entries = entriesOf(listed, kept ?? {}, release)
  for (const [path, file] of Object.entries(sitemapsOf(entries)))
    await write(path, file)
  await write("/sitemap.json", JSON.stringify(fingerprintsOf(listed, entries)))
  await write(`/${INDEXNOW_KEY}.txt`, INDEXNOW_KEY)
  const changed = entries.filter(({ lastmod }) => lastmod === release).length
  console.log(`Sitemap: ${entries.length} pages, ${changed} changed since ${kept ? ORIGIN : "nothing served"}`)
}
