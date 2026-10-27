// The map's sheet on a phone holds still: searching lays its suggestions over the week without taking it away or
// changing the sheet's size, the sheet keeps its height from page to page, Directions and Back included, unless it's
// dragged, and the camera follows the page shown alone, never one left behind as the clock ticks on

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

  await page.goto(fixture.origin + "/map/?place=Kingsbury+Hall")
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

test("the camera stays on the page shown: a page left behind, ticking on, never takes the map back to its place", async ({ page, fixture }) => {
  const start = Date.now()
  await page.clock.install({ time: start })
  await page.clock.resume()
  await withEvent(page, start)
  await open(page, fixture.origin, `/map/?event=${HONORS}`)
  const marker = page.locator(".focus-marker")
  await expect(marker).toHaveText(/^Huddleston Hall/)

  // Back, then Kingsbury Hall from the search
  await page.locator(".back").tap()
  await page.getByPlaceholder("Search campus").tap()
  await page.getByPlaceholder("Search campus").fill("Kingsbury Hall")
  await page.getByRole("option", { name: "Kingsbury Hall", exact: true }).dispatchEvent("pointerup")
  await expect(page.getByRole("heading", { name: "Kingsbury Hall" })).toBeVisible()
  await expect(marker).toHaveText("Kingsbury Hall")
  await page.waitForTimeout(1500)
  const there = (await marker.boundingBox())!

  // The event's page, left behind, runs on as the clock ticks, and the map stays where it is
  for (let minute = 0; minute < 4; minute++) {
    await page.clock.fastForward(60_000)
    await page.waitForTimeout(300)
    await expect(marker).toHaveText("Kingsbury Hall")
    const now = (await marker.boundingBox())!
    expect(Math.abs(now.x - there.x) + Math.abs(now.y - there.y)).toBeLessThan(2)
  }
})
