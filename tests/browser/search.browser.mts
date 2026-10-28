// A page of the map as a search engine and a first visit see it, against the Worker's app served from Node
// (tests/worker/serve.mts): its body says what it's of, server-rendered, with its own canonical address; the app then
// replaces that summary whole, leaving one heading; and once the service worker keeps the map, the page opens offline
// from the map as built, with no page's summary in it

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect } from "@playwright/test"
import { type Fixture, type Worker, startFixture, startWorker } from "./fixture.mts"
import { buildOf } from "../../src/shell/manifest.mts"
import { boardableStops, type FeedData } from "../../src/transit/feed.mts"
import { urlOf } from "../../src/map/link.mts"

/** The Worker's app, started once for every test this process runs of this file */
let worker: Worker | undefined

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    worker ??= await startWorker(process.env.NOTUNH_DIST!)
    const fixture = await startFixture(process.env.NOTUNH_DIST!, { worker: worker!.origin })
    await use(fixture)
    await fixture.close()
  }
})

test.afterAll(() => {
  worker?.process.kill()
  worker = undefined
})

// Every other origin, like Umo and the map's tiles, is out of reach
test.use({ proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })

/** The build's first stop a bus picks up at, by the timetable the map names */
const stopOf = (dist: string) => {
  const { data } = buildOf(readFileSync(join(dist, "map/index.html"), "utf8"))
  const feed = JSON.parse(readFileSync(join(dist, data.gtfs), "utf8")) as FeedData
  return feed.stops[[...boardableStops(feed)].sort((a, b) => a - b)[0]]
}

test("a stop's page says what it is in its body before any script, then the app replaces that whole, and it opens offline", async ({ browser, context, page, fixture }) => {
  const stop = stopOf(process.env.NOTUNH_DIST!)
  const path = urlOf({ kind: "stop", id: stop.id })

  // As a crawler reads it: the stop's own heading, its routes and times, and its own canonical address
  const shell = await (await browser.newContext({ javaScriptEnabled: false, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })).newPage()
  const response = await shell.goto(fixture.origin + path)
  expect(response?.status()).toBe(200)
  await expect(shell.locator("#app .summary h1")).toHaveText(stop.name)
  await expect(shell.locator("#app .summary")).toContainText("Next buses by the timetable")
  await expect(shell.locator("h1")).toHaveCount(1)
  await expect(shell.locator("link[rel=canonical]")).toHaveAttribute("href", `https://notunh.app${path}`)
  await shell.context().close()

  // As a visitor sees it: the app's page in the summary's place, the stop's name its one heading shown
  await page.goto(fixture.origin + path)
  await expect(page.locator(".view-head h1")).toHaveText(stop.name)
  await expect(page.locator(".summary")).toHaveCount(0)
  await expect(page.locator("h1:visible")).toHaveCount(1)
  await expect(page.getByRole("heading", { name: stop.name })).toHaveCount(1)

  // Kept by the service worker as the map as built, which says no page's summary, and opened from it offline
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const kept = () => page.evaluate(async () => (await (await caches.open("app-v2")).match("/map/"))?.text())
  await expect.poll(kept, { timeout: 15_000 }).toBeTruthy()
  const map = (await kept())!
  expect(map).not.toContain(`class="shell summary"`)
  expect(map).toContain(`<link rel="canonical" href="https://notunh.app/map/">`)
  await fixture.setOffline(true)
  const again = await context.newPage()
  await again.goto(fixture.origin + path)
  await expect(again.locator(".view-head h1")).toHaveText(stop.name)
  await expect(again.locator(".summary")).toHaveCount(0)
})

test("a path of the map naming nothing there is answers 404, kept out of search, and the app still opens", async ({ page, fixture }) => {
  const response = await page.goto(`${fixture.origin}/map/stop/no-such-stop`)
  expect(response?.status()).toBe(404)
  expect(response?.headers()["x-robots-tag"]).toBe("noindex")
  await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", "noindex")
  await expect(page.locator(".panel")).toBeVisible()
})
