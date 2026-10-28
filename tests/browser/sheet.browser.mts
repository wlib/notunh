// The map's sheet on a phone holds still: searching lays its suggestions over the week without taking it away or
// changing the sheet's size, and the sheet keeps its height from page to page, Directions and Back included, unless
// it's dragged. A trip's ends are marked only on its directions. A page opens at once, and Back, the sheet's or the
// browser's, returns to the list it was opened from scrolled as it was. The camera following only the page shown is
// tested in tests/map/camera.test.mts and page.test.mts, as the fixtures' map never loads, having no tiles

import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// A phone, with every other origin, like Umo and the map's tiles, out of reach
const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, viewport: { width: 390, height: 844 }, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York" })

/** An event today at Huddleston Hall, an hour from now, which the map lists and has a page for */
const HONORS = "test:honors-drop-in"

const withEvent = (page: Page, now: number) =>
  page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: {
    fetched: now,
    events: [{ id: HONORS, title: "Honors Drop In Advising", start: now - 600_000, end: now + 3_600_000, place: "Huddleston Hall", where: "Huddleston Hall", source: "25live", url: "https://example.com/" }]
  } }))

/** A long list of events at Huddleston Hall, every three hours for three weeks from two hours on, "Event 0" first */
const withWeeks = (page: Page, now: number) =>
  page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: {
    fetched: now,
    events: Array.from({ length: 168 }, (_, i) => ({
      id: `test:event-${i}`, title: `Event ${i}`, start: now + (2 + i * 3) * 3_600_000, end: now + (3 + i * 3) * 3_600_000,
      place: "Huddleston Hall", where: "Huddleston Hall", source: "25live", url: "https://example.com/"
    }))
  } }))

const open = async (page: Page, origin: string, path: string) => {
  await page.goto(origin + path)
  const no = page.getByRole("button", { name: "No", exact: true })
  await no.waitFor({ timeout: 3000 }).then(() => no.click(), () => {})
}

/** How much of the screen the sheet covers, once it's still */
const sheetHeight = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector(".panel")!.classList.contains("moving"))
  return page.evaluate(() => Math.round(innerHeight - document.querySelector(".panel")!.getBoundingClientRect().top))
}

/** How far down the sheet's content is scrolled, once it's still */
const scrollOf = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector(".panel")!.classList.contains("moving"))
  return page.evaluate(() => Math.round(document.querySelector(".panel")!.scrollTop))
}

/** Scrolls the sheet's content so the row given is in its middle, and says how far down that is */
const scrollToRow = async (page: Page, row: ReturnType<Page["locator"]>) => {
  await row.evaluate(element => element.scrollIntoView({ block: "center" }))
  // The sheet hears of it a frame later, as it does a finger's
  await page.waitForTimeout(100)
  return scrollOf(page)
}

/** That the sheet stays the height given, a moment after something might have moved it */
const holds = async (page: Page, height: number) => {
  await page.waitForTimeout(400)
  expect(await sheetHeight(page)).toBe(height)
}

test("searching lays suggestions over the week, keeping the sheet's size, and clearing it brings the week back as it was", async ({ page, fixture }) => {
  await withEvent(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const search = page.getByPlaceholder("Search campus")
  const week = page.locator(".agenda")
  await expect(page.getByRole("list", { name: "Now" })).toContainText("Honors Drop In Advising")
  const height = await sheetHeight(page)

  // Focus alone changes nothing
  await search.tap()
  await expect(week).toBeVisible()
  await expect(page.locator(".suggested")).toHaveCount(0)
  await holds(page, height)

  // Typing lays the suggestions over the week, which stays, unreachable beneath them
  await search.fill("Kingsbury")
  await expect(page.getByRole("option", { name: "Kingsbury Hall", exact: true })).toBeVisible()
  await expect(week).toHaveAttribute("inert", "")
  await expect(week.getByText("Honors Drop In Advising")).toBeAttached()
  await holds(page, height)

  // Cleared, the week's back, as it was
  await search.fill("")
  await expect(page.locator(".suggested")).toHaveCount(0)
  await expect(week).not.toHaveAttribute("inert", "")
  await expect(page.getByRole("list", { name: "Now" })).toContainText("Honors Drop In Advising")
  await holds(page, height)

  // And dismissed after typing, too
  await search.fill("Kings")
  await page.keyboard.press("Escape")
  await expect(week).toBeVisible()
  await holds(page, height)
})

test("the sheet keeps its height through Directions and Back, from home and from a place, and a drag's height after", async ({ page, fixture }) => {
  // Five map pages in one, which Chromium draws in software alongside the other tests
  test.slow()
  await open(page, fixture.origin, "/map/")
  const half = await sheetHeight(page)
  const back = page.locator(".back")

  await page.getByRole("button", { name: "Directions", exact: true }).tap()
  await expect(page.getByPlaceholder("Where to?")).toBeVisible()
  await holds(page, half)
  await back.tap()
  await holds(page, half)

  await page.goto(fixture.origin + "/map/place/Kingsbury+Hall")
  await holds(page, half)
  await page.locator(".view-actions").getByRole("button", { name: "Directions" }).tap()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await holds(page, half)
  await back.tap()
  await expect(page.getByRole("heading", { name: "Kingsbury Hall" })).toBeVisible()
  await holds(page, half)
  await back.tap()
  await holds(page, half)

  // Dragged up by its grabber, it stays that tall from page to page
  const grabber = (await page.locator(".grabber").boundingBox())!
  await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + grabber.height / 2)
  await page.mouse.down()
  await page.mouse.move(grabber.x + grabber.width / 2, 120, { steps: 8 })
  await page.mouse.up()
  const tall = await sheetHeight(page)
  expect(tall).toBeGreaterThan(half + 100)
  await page.getByRole("button", { name: "Directions", exact: true }).tap()
  await holds(page, tall)
  await back.tap()
  await holds(page, tall)
})

test("an event's row opens its page at once, the week beneath it left as it was", async ({ page, fixture, browserName }) => {
  await withWeeks(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const row = page.locator(".agenda").getByRole("button", { name: /Event 30\b/ }).first()
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  // A phone's slower than a laptop, so Chromium runs at a sixth of its speed, as Playwright can't slow WebKit
  if (browserName === "chromium")
    await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 6 })

  // From the tap to the frame after the page's heading is in, and anything that changed in the week meanwhile
  type Timed = { ms: number, loading: boolean, weekChanged: number }
  await page.evaluate(() => void Object.assign(window, { timed: new Promise<Timed>(resolve => {
    let tapped = 0
    let loading = false
    let weekChanged = 0
    addEventListener("click", event => tapped = event.timeStamp, { capture: true, once: true })
    new MutationObserver(records => weekChanged += records.length).observe(document.querySelector(".agenda")!, { childList: true, subtree: true, characterData: true })
    const shown = new MutationObserver(() => {
      loading ||= document.querySelector(".view")?.textContent?.includes("Loading") ?? false
      if (document.querySelector(".view h1")?.textContent === "Event 30") {
        shown.disconnect()
        requestAnimationFrame(() => resolve({ ms: performance.now() - tapped, loading, weekChanged }))
      }
    })
    shown.observe(document.querySelector(".panel")!, { childList: true, subtree: true })
  }) }))
  await row.tap()
  const { ms, loading, weekChanged } = await page.evaluate(() => (window as unknown as { timed: Promise<Timed> }).timed)
  expect.soft(loading).toBe(false)
  expect.soft(weekChanged).toBe(0)
  expect.soft(ms).toBeLessThan(150)
  await expect(page.getByRole("heading", { name: "Event 30" })).toBeVisible()
})

test("Back, the sheet's or the browser's, returns to the week and to a place's events scrolled as they were left", async ({ page, fixture }) => {
  test.slow()
  await withWeeks(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const back = page.locator(".back")
  const week = page.locator(".agenda")
  await expect(week.getByRole("button", { name: /Event 30\b/ }).first()).toBeVisible()

  // Further down the week than it first shows, a week later
  await page.getByRole("button", { name: "Later ›" }).tap()
  const later = week.getByRole("button", { name: /Event 70\b/ }).first()
  for (const leave of [() => back.tap(), () => page.goBack()]) {
    const scrolled = await scrollToRow(page, later)
    expect(scrolled).toBeGreaterThan(1000)
    await later.tap()
    await expect(page.getByRole("heading", { name: "Event 70" })).toBeVisible()
    expect(await scrollOf(page)).toBe(0)
    await leave()
    await expect(later).toBeVisible()
    expect(await scrollOf(page)).toBe(scrolled)
  }

  // And Forward to the event, and Back to the week again, each where it was
  await page.goForward()
  await expect(page.getByRole("heading", { name: "Event 70" })).toBeVisible()
  await page.goBack()
  await expect(later).toBeVisible()
  expect(await scrollOf(page)).toBeGreaterThan(1000)

  // A place's page, opened from an event's, and made anew as Back returns to it
  await later.tap()
  await page.locator(".lines").getByRole("button", { name: /Huddleston Hall/ }).tap()
  const there = page.locator(".view").getByRole("button", { name: /Event 15\b/ }).first()
  for (const leave of [() => back.tap(), () => page.goBack()]) {
    const scrolled = await scrollToRow(page, there)
    expect(scrolled).toBeGreaterThan(300)
    await there.tap()
    await expect(page.getByRole("heading", { name: "Event 15" })).toBeVisible()
    await leave()
    await expect(page.getByRole("heading", { name: "Huddleston Hall" })).toBeVisible()
    expect(await scrollOf(page)).toBe(scrolled)
  }
})

test("a trip's ends are marked on the map only while its directions are shown, though Back keeps the trip", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/place/Kingsbury+Hall")
  const ends = page.locator(".maplibregl-marker:not(.focus-marker)")
  await page.locator(".view-actions").getByRole("button", { name: "Directions" }).tap()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await expect(ends).toHaveCount(1)

  await page.locator(".back").tap()
  await expect(page.getByRole("heading", { name: "Kingsbury Hall" })).toBeVisible()
  await expect(ends).toHaveCount(0)
  await page.locator(".back").tap()
  await expect(ends).toHaveCount(0)

  // Directions again still has the trip, marked again
  await page.getByRole("button", { name: "Directions", exact: true }).tap()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await expect(ends).toHaveCount(1)
})
