// Pages as they first load in real browsers: what they download, and what they show from it

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as base, expect, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

/**
 * Every file of ours the page's head names, its data and its code, the code it loads later included, by path; but a
 * polyfill for what this browser has of its own, which is never fetched (src/shell/manifest.mts)
 */
const namedOf = (page: Page) =>
  page.evaluate(() => [...document.head.querySelectorAll<HTMLElement>("link[href^='/assets/'], script[src^='/assets/']")]
    .filter(tag => !(tag.dataset.for && tag.dataset.for in globalThis))
    .map(tag => tag.getAttribute("href") ?? tag.getAttribute("src")!))

/** Waits until the worker controls the page and keeps the page itself, so it has staged all the page names */
const staged = async (page: Page, path: string) => {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await expect.poll(() => page.evaluate(async path => !!await (await caches.open("app-v2")).match(path), path), { timeout: 15_000 }).toBe(true)
}

test("each file a page names downloads once, on a first visit however slowly it comes, and not again on the next", async ({ playwright, browserName, fixture }) => {
  // A context of its own on disk, since WebKit's in memory has no HTTP cache, which the worker's staging reads from.
  // Every other origin, like Umo and the map's tiles, is out of reach
  const context = await playwright[browserName].launchPersistentContext(mkdtempSync(join(tmpdir(), "notunh-profile-")), { proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })
  try {
    const page = context.pages()[0] ?? await context.newPage()
    await fixture.setDelay(1000)
    for (const path of ["/dining/", "/map/"]) {
      const downloads = (url: string) => fixture.requests.filter(request => request === url).length
      await page.goto(fixture.origin + path)
      await staged(page, path)
      const named = await namedOf(page)
      expect(named.some(url => url.endsWith(".json"))).toBe(true)
      for (const url of named)
        expect(downloads(url), url).toBe(1)

      await page.goto("about:blank")
      await page.goto(fixture.origin + path)
      await page.waitForLoadState("networkidle")
      for (const url of named)
        expect(downloads(url), url).toBe(1)
    }
  }
  finally {
    await context.close()
  }
})

// The dining fixtures' menus are for October 7 and 8, 2026, when every hall but Philbrook on weekends is open. A
// build here may take real menus instead, which run a couple of weeks from the day it's made, so the day with none is
// a couple of months after the tests run, as a day before any menus opens on the first that has one
const WITH_MENUS = new Date("2026-10-07T16:00:00Z")
const NO_MENUS   = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)

test("dining first opens on a day without a menu saying so, not loading forever", async ({ page, fixture }) => {
  await page.clock.setFixedTime(NO_MENUS)
  await page.goto(`${fixture.origin}/dining/`)
  await expect(page.locator("main.dining")).toContainText("hasn't posted a menu for that day yet")
})

test("dining first opens on a day with a menu showing it", async ({ page, fixture }) => {
  await page.clock.setFixedTime(WITH_MENUS)
  await page.goto(`${fixture.origin}/dining/`)
  await expect(page.locator(".stations .station").first()).toBeVisible()
  expect(fixture.requests.filter(path => path.startsWith("/data/dining/"))).toHaveLength(1)
})

test("each page shows its header and what it does before any script runs, where its app then puts its header", async ({ browser, fixture }) => {
  // Every other origin, like Umo and the map's tiles, is out of reach
  const proxy = { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }
  const shell = await (await browser.newContext({ javaScriptEnabled: false, proxy })).newPage()
  const app = await (await browser.newContext({ proxy })).newPage()
  await app.clock.setFixedTime(WITH_MENUS)
  for (const [path, loaded] of [["/map/", ".search-field"], ["/dining/", ".controls"], ["/laundry/", ".rooms-head"]]) {
    await shell.goto(fixture.origin + path)
    await expect(shell.locator("#app .shell")).toBeVisible()
    await app.goto(fixture.origin + path)
    await expect(app.locator(loaded).first()).toBeAttached()
    expect(await app.locator(".app-title").boundingBox(), path).toEqual(await shell.locator(".app-title").boundingBox())
  }
  await expect(shell.locator("a.room-open").first()).toHaveAttribute("href", /^\/laundry\/[\w-]+\/$/)
  await shell.context().close()
  await app.context().close()
})

test("the home page is the home page on a first visit and from the site, and goes on to the map from anywhere else once this device has had it, which Back passes by", async ({ page, fixture }) => {
  await page.goto(`${fixture.origin}/`)
  await expect(page.locator(".wordmark")).toBeVisible()
  await page.getByRole("link", { name: /Open the map/ }).click()
  await expect(page).toHaveURL(`${fixture.origin}/map/`)
  await page.waitForFunction(() => localStorage.getItem("map-trip") !== null)

  // Typed, as from the home screen or a search: on to the map, in place of the home page, so Back leaves the site
  await page.goto("about:blank")
  await page.goto(`${fixture.origin}/`)
  await expect(page).toHaveURL(`${fixture.origin}/map/`)
  await page.goBack()
  await expect(page).toHaveURL("about:blank")

  // From another of the site's pages, the home page itself, which a reload keeps
  await page.goto(`${fixture.origin}/dining/`)
  await page.locator(".app-title").getByRole("link", { name: "notunh" }).click()
  await expect(page).toHaveURL(`${fixture.origin}/`)
  await page.reload()
  await expect(page).toHaveURL(`${fixture.origin}/`)
  await expect(page.locator(".wordmark")).toBeVisible()
})

test("a laundry room has one way back: to the list it was opened from, else to the map", async ({ page, fixture }) => {
  await page.goto(`${fixture.origin}/laundry/`)
  const room = page.locator("a.room-open").first()
  const path = await room.getAttribute("href")
  await room.click()
  await expect(page).toHaveURL(`${fixture.origin}${path}`)
  await expect(page.locator(".back")).toHaveCount(1)
  await page.locator(".back").click()
  await expect(page).toHaveURL(`${fixture.origin}/laundry/`)
  await expect(page.locator(".back")).toHaveText(/Map/)

  // Opened at its own address, as from the map's place or a bookmark, the way back is the map's
  await page.goto(`${fixture.origin}${path}`)
  await expect(page.locator(".back")).toHaveCount(1)
  await expect(page.locator(".back")).toHaveText(/Map/)
  await expect(page.locator(".back")).toHaveAttribute("href", "/map/laundry")
})
