// The service worker in real browsers, over the release sequences the in-memory tests pin (tests/shell/sw.test.mts):
// each test gets a fresh browser context, so a fresh cache and worker, against a fixture server of its own

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"
import { type Fixture, HALL_SUFFIX, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

const CACHE = "app-v2"

/** Opens a page and waits until the worker is in charge of it */
const open = async (context: BrowserContext, url: string) => {
  const page = await context.newPage()
  await page.goto(url)
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  return page
}

/** The release of the copy of a page the cache holds, or undefined without one */
const cachedRelease = (page: Page, path: string, cache = CACHE) =>
  page.evaluate(async ([path, cache]) => {
    const copy = await (await caches.open(cache)).match(path)
    return copy && (await copy.text()).match(/<meta name="release" content="([^"]*)">/)?.[1]
  }, [path, cache])

/** Waits until the cache holds a page from a release */
const cachedFrom = (page: Page, path: string, release: string) =>
  expect.poll(() => cachedRelease(page, path), { timeout: 10_000 }).toBe(release)

const RELEASE = { A: "2026-10-18T08:00:00.000Z", B: "2026-10-19T08:00:00.000Z", C: "2026-10-20T08:00:00.000Z", D: "2026-10-21T08:00:00.000Z" }

/** Every script and data file the page's head names */
const named = (page: Page) =>
  page.evaluate(() => [...document.head.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src], link[href]")].map(tag => "src" in tag && tag.src || (tag as HTMLLinkElement).href).filter(url => new URL(url).pathname.startsWith("/assets/")))

const isFetchable = (page: Page, url: string) =>
  page.evaluate(url => fetch(url).then(response => response.ok, () => false), url)

test("a visited page opens from the cache, whole, offline, and an unvisited one shows the home page", async ({ context, fixture }) => {
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.A)
  // The home page is kept from the start, as built
  await expect.poll(() => cachedRelease(page, "/")).toBeTruthy()
  await fixture.setOffline(true)
  const again = await context.newPage()
  await again.goto(`${fixture.origin}/dining/`)
  await expect(again.locator("main.dining")).toBeVisible()
  for (const url of await named(again))
    expect(await isFetchable(again, url), url).toBe(true)
  const elsewhere = await context.newPage()
  await elsewhere.goto(`${fixture.origin}/laundry/`)
  await expect(elsewhere.locator("main.page")).toBeVisible()
})

test("an old tab keeps working while another tab brings in a new release, and the new tab opens whole", async ({ context, fixture }) => {
  const old = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(old, "/dining/", RELEASE.A)
  const assets = await named(old)

  await fixture.publish("B")
  const other = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(other, "/dining/", RELEASE.B)
  await cachedFrom(other, "/dining/?gen=prev", RELEASE.A)
  // The unchanged navigation that used to prune
  await other.goto(`${fixture.origin}/`)
  await other.goto(`${fixture.origin}/`)
  await fixture.setOffline(true)

  for (const url of assets)
    expect(await isFetchable(old, url), url).toBe(true)
  const again = await context.newPage()
  await again.goto(`${fixture.origin}/dining/`)
  await expect(again.locator("main.dining")).toBeVisible()
  expect(await again.evaluate(() => [...document.scripts].some(script => script.src.includes("index-BBBBBBBB")))).toBe(true)
})

test("a release whose code differs reloads an open tab only once it's out of view", async ({ context, fixture }) => {
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.A)
  await page.evaluate(() => void ((window as unknown as { marker: boolean }).marker = true))
  await fixture.publish("B")
  await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({ revalidate: location.pathname }))
  await cachedFrom(page, "/dining/", RELEASE.B)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true)

  // Out of view, the page reloads at once, which ends the script telling it so
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  }).catch(() => {})
  // Until the reload is through, the page can't be asked anything
  await expect.poll(() => page.evaluate(() => (window as unknown as { marker?: boolean }).marker).catch(() => true)).toBeUndefined()
  await expect.poll(() => page.evaluate(() => [...document.scripts].some(script => script.src.includes("index-BBBBBBBB"))).catch(() => false)).toBe(true)
})

test("a release whose data differs is loaded by an open tab and shown, without a reload", async ({ context, fixture }) => {
  await fixture.publish("B")
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.B)
  await page.evaluate(() => void ((window as unknown as { marker: boolean }).marker = true))
  await expect(page.locator("main.dining")).not.toContainText(HALL_SUFFIX)
  await fixture.publish("C")
  await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({ revalidate: location.pathname }))
  await cachedFrom(page, "/dining/", RELEASE.C)
  // C's index names the first hall otherwise, which the page shows once it has swapped C's data in
  await expect(page.locator("main.dining")).toContainText(HALL_SUFFIX)
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true)
})

test("a release with a new worker takes over an open tab without losing its files, leaving the first worker's pages to be fetched afresh", async ({ context, fixture }) => {
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.A)
  const assets = await named(page)
  // What the first worker kept, under its own cache, for a tab on its page: the page, naming only its code as pages
  // did then, the code, and the data that code loaded by URL
  await page.evaluate(async () => {
    const old = await caches.open("app-v1")
    await old.put("/map/", new Response("<!doctype html><html><head><script type=\"module\" src=\"/assets/old-OLDOLDOL.js\"></script></head><body></body></html>", { headers: { "content-type": "text/html" } }))
    await old.put("/assets/old-OLDOLDOL.js", new Response("old", { headers: { "content-type": "text/javascript" } }))
    await old.put("/assets/gtfs-OLDOLDOL.json", new Response("{}", { headers: { "content-type": "application/json" } }))
  })
  await fixture.publish("D")
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => registration!.update()))
  // The new worker installs, takes over the tab, which asks it to check its page, and keeps D whole
  await expect.poll(() => page.evaluate(() => caches.keys()), { timeout: 15_000 }).toEqual([CACHE])
  await cachedFrom(page, "/dining/", RELEASE.D)
  // The first worker's page can't say what it needs, so it isn't served without its data, but fetched afresh
  const kept = (path: string) => page.evaluate(([cache, path]) => caches.open(cache).then(c => c.match(path)).then(copy => copy?.text()), [CACHE, path])
  expect(await kept("/map/")).toBeUndefined()
  expect(await kept("/assets/gtfs-OLDOLDOL.json")).toBeUndefined()
  await fixture.setOffline(true)
  for (const url of assets)
    expect(await isFetchable(page, url), url).toBe(true)
  const again = await context.newPage()
  await again.goto(`${fixture.origin}/dining/`)
  await expect(again.locator("main.dining")).toContainText(HALL_SUFFIX)
})

test("an older release served again, as by an edge not yet caught up or a rollback, is left alone", async ({ context, fixture }) => {
  await fixture.publish("B")
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.B)
  await fixture.publish("A")
  await page.goto(`${fixture.origin}/dining/`)
  await page.waitForTimeout(1000)
  expect(await cachedRelease(page, "/dining/")).toBe(RELEASE.B)
  expect(await page.evaluate(() => [...document.scripts].some(script => script.src.includes("index-BBBBBBBB")))).toBe(true)
})

test("a newer page that names a file the network can't serve is never kept, so the copy we have still opens offline", async ({ context, fixture }) => {
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.A)
  await fixture.setStatus("/assets/dining/index-BBBBBBBB.js", 500)
  await fixture.publish("B")
  await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({ revalidate: location.pathname }))
  await page.waitForTimeout(1000)
  expect(await cachedRelease(page, "/dining/")).toBe(RELEASE.A)
  await fixture.setOffline(true)
  const again = await context.newPage()
  await again.goto(`${fixture.origin}/dining/`)
  await expect(again.locator("main.dining")).toBeVisible()
})
