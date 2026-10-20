// What a build adds beside its pages for search engines (npm's postbuild): IndexNow's key file and the sitemap. The
// social images are made by hand (social.mts) and kept in public/social/. A page's lastmod is when what it serves last
// changed: this build's release if the page differs from the one the site serves now by more than its release, else
// the lastmod the site's sitemap gives it. So a nightly build changes the dining page's for its new menus, and leaves
// the home page's alone. Offline, as pull requests are built, nothing is compared and every page is this build's

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { jsx } from "bruh/server"
import { buildOf } from "../src/shell/manifest.mts"
import { INDEXNOW_KEY, PATHS, SITE } from "../src/shell/pages.mts"
import { isOffline } from "./files.mts"
import { ORIGIN } from "./site.mts"

export const DIST = new URL("../dist/", import.meta.url)

/** A page as it reads, without when it was built or republished, which change with every build */
export const contentOf = (html: string) =>
  html.replace(/<meta name="(release|published)" content="[^"]*">/g, "")

/** When a page last changed, given the page built and the one served now, if any, with the lastmod served for it */
export const lastmodOf = (built: string, served?: string, servedLastmod?: string) => {
  if (served === undefined || contentOf(built) !== contentOf(served))
    return buildOf(built).release
  const { published, release } = buildOf(served)
  return servedLastmod ?? published ?? release
}

/** A sitemap of pages and when each last changed */
export const sitemapOf = async (entries: { loc: string, lastmod: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n${await jsx("urlset", {
    // bruh types the attributes of HTML, SVG, and MathML alone, so the sitemap's namespace goes untyped
    ...{ xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9" } as {},
    children: entries.map(({ loc, lastmod }) => jsx("url", { children: [jsx("loc", { children: loc }), jsx("lastmod", { children: lastmod })] }))
  }).toStringPromise()}\n`

/** Each page's lastmod in a sitemap, by its URL */
export const lastmodsOf = (sitemap: string) =>
  new Map([...sitemap.matchAll(/<loc>([^<]*)<\/loc><lastmod>([^<]*)<\/lastmod>/g)].map(([, loc, lastmod]) => [loc, lastmod]))

/** What the site serves at a path now, or undefined when it can't be read, as offline */
const served = async (path: string) => {
  if (isOffline)
    return
  try {
    const response = await fetch(ORIGIN + path, { cache: "no-store" })
    if (response.ok)
      return await response.text()
    console.warn(`Couldn't read ${ORIGIN}${path} (${response.status})`)
  }
  catch (error) {
    console.warn(`Couldn't read ${ORIGIN}${path} (${error instanceof Error ? error.message : error})`)
  }
}

const write = async (path: string, data: string | Uint8Array) => {
  const file = new URL(`.${path}`, DIST)
  await mkdir(new URL(".", file), { recursive: true })
  await writeFile(file, data)
}

if (import.meta.main) {
  const servedLastmods = lastmodsOf(await served("/sitemap.xml") ?? "")
  const entries = await Promise.all(PATHS.map(async path => {
    const loc = SITE + path
    const built = await readFile(new URL(`.${path}index.html`, DIST), "utf8")
    return { loc, lastmod: lastmodOf(built, await served(path), servedLastmods.get(loc)) }
  }))
  await write("/sitemap.xml", await sitemapOf(entries))
  await write(`/${INDEXNOW_KEY}.txt`, INDEXNOW_KEY)
  console.log(`Sitemap: ${entries.map(({ loc, lastmod }) => `${loc} ${lastmod}`).join(", ")}`)
}
