import { test, expect } from "vitest"
import fc from "fast-check"
import { type Entry, type Listed, contentOf, entriesOf, fingerprintsOf, sitemapOf, sitemapsOf } from "../scripts/search.mts"
import { BATCH, ENDPOINT, changedOf, submit } from "../scripts/indexnow.mts"
import { INDEXNOW_KEY, SITE } from "../src/shell/pages.mts"

const pageAt = (release: string, body = "<p>Menus</p>") =>
  `<!doctype html><html><head><meta name="release" content="${release}"></head><body>${body}</body></html>`

const instant = fc.date({ min: new Date("2026-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map(date => date.toISOString())

/** Each page's address in a sitemap, with its lastmod */
const lastmodsOf = (sitemap: string) =>
  new Map([...sitemap.matchAll(/<loc>([^<]*)<\/loc><lastmod>([^<]*)<\/lastmod>/g)].map(([, loc, lastmod]) => [loc, lastmod]))

/** Pages of the site, each once, with fingerprints */
const listed = fc.uniqueArray(fc.record({ loc: fc.webPath().map(path => SITE + path), fingerprint: fc.string({ minLength: 1, maxLength: 4 }) }), { selector: ({ loc }) => loc, maxLength: 30 })

test("a page that says what it said keeps the lastmod served for it, and one that says something else, or is new, gets this build's", () => {
  fc.assert(fc.property(listed, fc.func(fc.boolean()), instant, instant, (pages, isSame, lastmod, release) => {
    const served = Object.fromEntries(pages.flatMap(({ loc, fingerprint }, index) => index % 3 === 2 ? [] : [[loc, [isSame(loc) ? fingerprint : `${fingerprint}!`, lastmod]]])) as Record<string, [string, string]>
    entriesOf(pages, served, release).forEach(({ loc, lastmod: got }, index) => {
      expect(loc).toBe(pages[index].loc)
      expect(got).toBe(index % 3 !== 2 && isSame(loc) ? lastmod : release)
    })
    // Before the site serves any, every page is this build's
    expect(entriesOf(pages, {}, release).every(({ lastmod }) => lastmod === release)).toBe(true)
  }))
})

test("a page republished, as in a rollback, reads as it did", () => {
  const republished = pageAt("2026-10-01T00:00:00.000Z").replace("</head>", `<meta name="published" content="2026-10-02T00:00:00.000Z"></head>`)
  expect(contentOf(republished)).toBe(contentOf(pageAt("2026-10-03T00:00:00.000Z")))
  expect(contentOf(pageAt("2026-10-03T00:00:00.000Z", "<p>Other menus</p>"))).not.toBe(contentOf(republished))
})

test("a sitemap reads back as it was written, escaped as XML, in the protocol's namespace", () =>
  fc.assert(fc.property(listed, instant, (pages, release) => {
    const entries = entriesOf(pages, {}, release)
    const sitemap = sitemapOf(entries)
    expect(sitemap).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">(<url><loc>[^<]*<\/loc><lastmod>[^<]*<\/lastmod><\/url>)*<\/urlset>\n$/)
    expect(lastmodsOf(sitemap.replaceAll("&amp;", "&"))).toEqual(new Map(entries.map(({ loc, lastmod }) => [loc, lastmod])))
  }))
)

test("past the limit, the sitemap is an index of sitemaps, each within it, listing every page once, and changed when its latest page did", () =>
  fc.assert(fc.property(listed, fc.integer({ min: 1, max: 8 }), fc.array(instant, { minLength: 30, maxLength: 30 }), (pages, limit, lastmods) => {
    const entries: Entry[] = pages.map(({ loc }, index) => ({ loc, lastmod: lastmods[index] }))
    const files = sitemapsOf(entries, limit)
    if (entries.length <= limit) {
      expect(Object.keys(files)).toEqual(["/sitemap.xml"])
      return
    }
    const parts = Object.keys(files).filter(path => path !== "/sitemap.xml")
    expect(parts).toHaveLength(Math.ceil(entries.length / limit))
    const index = lastmodsOf(files["/sitemap.xml"].replaceAll(/<\/?sitemap>/g, ""))
    expect([...index.keys()]).toEqual(parts.map(path => SITE + path))
    const listedIn = parts.map(path => lastmodsOf(files[path].replaceAll("&amp;", "&")))
    for (const [i, part] of listedIn.entries()) {
      expect(part.size).toBeLessThanOrEqual(limit)
      expect(index.get(SITE + parts[i])).toBe([...part.values()].sort().at(-1))
    }
    expect(listedIn.flatMap(part => [...part])).toEqual(entries.map(({ loc, lastmod }) => [loc, lastmod]))
  }))
)

test("a deploy submits exactly the pages whose lastmod is its release", () =>
  fc.assert(fc.property(listed, instant, fc.func(fc.boolean()), (pages, release, isChanged) => {
    const entries = pages.map(({ loc }) => ({ loc, lastmod: isChanged(loc) ? release : "2025-01-01T00:00:00.000Z" }))
    expect(changedOf(fingerprintsOf(pages as Listed[], entries), release)).toEqual(pages.filter(({ loc }) => isChanged(loc)).map(({ loc }) => loc))
  }))
)

/** A fetch that answers with a status, recording what it's asked */
const stub = (status: number) => {
  const asked: { url: string, init?: RequestInit }[] = []
  const load = async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: `${url}`, init })
    return new Response(null, { status })
  }
  return { asked, load: load as typeof fetch }
}

test("pages changed are submitted to IndexNow with the site's key, as many to a request as it takes, and none changed asks nothing", async () => {
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

  const many = Array.from({ length: BATCH + 1 }, (_, index) => `${SITE}/map/event/${index}`)
  await submit(many, load)
  const lists = asked.slice(1).map(({ init }) => JSON.parse(`${init?.body}`).urlList)
  expect(lists.map(list => list.length)).toEqual([BATCH, 1])
  expect(lists.flat()).toEqual(many)
})

test("a submission IndexNow refuses fails", async () => {
  await expect(submit([`${SITE}/`], stub(422).load)).rejects.toThrow("422")
})
