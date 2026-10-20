import { test, expect } from "vitest"
import fc from "fast-check"
import { contentOf, lastmodOf, lastmodsOf, sitemapOf } from "../scripts/search.mts"
import { ENDPOINT, changedOf, submit } from "../scripts/indexnow.mts"
import { INDEXNOW_KEY, PATHS, SITE } from "../src/shell/pages.mts"

const pageAt = (release: string, body = "<p>Menus</p>") =>
  `<!doctype html><html><head><meta name="release" content="${release}"></head><body>${body}</body></html>`

const instant = fc.date({ min: new Date("2026-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map(date => date.toISOString())

test("a page that reads the same as the one served keeps its lastmod, and one that doesn't gets this build's release", () => {
  fc.assert(fc.property(instant, instant, instant, fc.boolean(), (built, served, lastmod, isSame) => {
    const page = pageAt(built)
    const servedPage = pageAt(served, isSame ? "<p>Menus</p>" : "<p>Other menus</p>")
    expect(lastmodOf(page, servedPage, lastmod)).toBe(isSame ? lastmod : built)
    // Before the site serves a sitemap, an unchanged page last changed when the served one was built
    expect(lastmodOf(page, servedPage)).toBe(isSame ? served : built)
    expect(lastmodOf(page)).toBe(built)
  }))
})

test("a page republished, as in a rollback, reads as it did, and last changed when it was republished", () => {
  const republished = pageAt("2026-10-01T00:00:00.000Z").replace("</head>", `<meta name="published" content="2026-10-02T00:00:00.000Z"></head>`)
  expect(contentOf(republished)).toBe(contentOf(pageAt("2026-10-03T00:00:00.000Z")))
  expect(lastmodOf(pageAt("2026-10-03T00:00:00.000Z"), republished)).toBe("2026-10-02T00:00:00.000Z")
})

test("a sitemap reads back as it was written", () => {
  fc.assert(fc.property(fc.array(instant, { minLength: PATHS.length, maxLength: PATHS.length }), lastmods => {
    const entries = PATHS.map((path, index) => ({ loc: SITE + path, lastmod: lastmods[index] }))
    expect(lastmodsOf(sitemapOf(entries))).toEqual(new Map(entries.map(({ loc, lastmod }) => [loc, lastmod])))
  }))
})

test("a deploy submits exactly the pages whose lastmod is its release", () => {
  fc.assert(fc.property(instant, fc.array(fc.boolean(), { minLength: PATHS.length, maxLength: PATHS.length }), (release, changed) => {
    const sitemap = sitemapOf(PATHS.map((path, index) => ({ loc: SITE + path, lastmod: changed[index] ? release : "2025-01-01T00:00:00.000Z" })))
    expect(changedOf(sitemap, release)).toEqual(PATHS.filter((_, index) => changed[index]).map(path => SITE + path))
  }))
})

/** A fetch that answers with a status, recording what it's asked */
const stub = (status: number) => {
  const asked: { url: string, init?: RequestInit }[] = []
  const load = async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: `${url}`, init })
    return new Response(null, { status })
  }
  return { asked, load: load as typeof fetch }
}

test("pages changed are submitted to IndexNow in one request with the site's key, and none changed asks nothing", async () => {
  const { asked, load } = stub(202)
  await submit([], load)
  expect(asked).toEqual([])

  await submit([`${SITE}/dining/`, `${SITE}/map/`], load)
  expect(asked).toHaveLength(1)
  expect(asked[0].url).toBe(ENDPOINT)
  expect(asked[0].init?.method).toBe("POST")
  expect(JSON.parse(`${asked[0].init?.body}`)).toEqual({
    host:        "notunh.app",
    key:         INDEXNOW_KEY,
    keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
    urlList:     [`${SITE}/dining/`, `${SITE}/map/`]
  })
})

test("a submission IndexNow refuses fails", async () => {
  await expect(submit([`${SITE}/`], stub(422).load)).rejects.toThrow("422")
})
