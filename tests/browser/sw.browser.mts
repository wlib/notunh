// The service worker in real browsers, over the release sequences the in-memory tests pin (tests/shell/sw.test.mts):
// each test gets a fresh browser context, so a fresh cache and worker, against a fixture server of its own

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"

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

const RELEASE = { A: "2026-10-18T08:00:00.000Z", B: "2026-10-19T08:00:00.000Z", C: "2026-10-20T08:00:00.000Z" }

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

test("a release whose data differs is loaded by an open tab without a reload", async ({ context, fixture }) => {
  await fixture.publish("B")
  const page = await open(context, `${fixture.origin}/dining/`)
  await cachedFrom(page, "/dining/", RELEASE.B)
  await page.evaluate(() => void ((window as unknown as { marker: boolean }).marker = true))
  await fixture.publish("C")
  await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({ revalidate: location.pathname }))
  await cachedFrom(page, "/dining/", RELEASE.C)
  await expect.poll(() => fixture.requests.some(path => path.includes("menus-CCCCCCCC"))).toBe(true)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true)
  await expect(page.locator("main.dining")).toBeVisible()
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
