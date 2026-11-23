// UNH's teams' scores on a phone: Campus's line with the latest result, which opens every result a day at a time,
// newest first, and the next games while there are some; a game's page with its final score; and search finding a
// sport's results and the page

import { test as base, expect, devices } from "@playwright/test"
import { type Fixture, open, shoot, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// A phone, with every other origin, like Umo and the map's tiles, out of reach
const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York" })

test("Campus says the latest result, which opens the scores, newest first a day at a time", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/")
  const row = page.getByRole("list", { name: "Campus" }).getByRole("button", { name: /Sports/ })
  // The fixtures' latest result, Women's Cross Country's place at America East's championship on 30 October 2026
  await expect(row).toContainText("8th place at America East Championship · Women's Cross Country")
  await row.scrollIntoViewIfNeeded()
  await shoot(page, "sports-campus")
  await row.click()
  await expect(page).toHaveURL(/\/map\/sports$/)
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Sports")
  const days = view.locator("ul.rows[aria-label]")
  await expect(days.first()).toHaveAttribute("aria-label", "2026-10-30")
  const labels = await days.evaluateAll(lists => lists.map(list => list.getAttribute("aria-label")!))
  expect(labels).toEqual([...labels].sort().reverse())
  await expect(days.first().locator(".score")).toHaveText("8th")
  const bryant = view.locator(".row", { hasText: "at Bryant" })
  await expect(bryant).toContainText("Field Hockey")
  await expect(bryant).toContainText("at Bryant · Away")
  await expect(bryant.locator(".score")).toHaveText("W 2–1 OT")
  await expect(view.getByText("vs Dartmouth · Home")).toBeVisible()
  // As of today, every game the fixtures have is over
  await expect(view.getByRole("heading", { name: "Next" })).toHaveCount(0)
  await shoot(page, "sports")
})

test("before a game, the scores lead with it as next", async ({ page, fixture }) => {
  // The evening of Wednesday 28 October 2026, before Field Hockey's game at Bryant and Men's Ice Hockey's at Vermont
  await page.clock.setFixedTime(new Date("2026-10-28T22:00:00Z"))
  await open(page, fixture.origin, "/map/sports")
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { name: "Next" })).toBeVisible()
  const next = view.locator("ul.rows").first().locator(".row")
  await expect(next).toHaveCount(1)
  await expect(next).toContainText("Men's Ice Hockey")
  await expect(next).toContainText("at Vermont · Away")
  await shoot(page, "sports-next")
})

test("a game played opens on its final score, with nothing to save or get there by", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/sports")
  await page.locator(".view .row", { hasText: "vs Dartmouth" }).click()
  await expect(page).toHaveURL(/\/map\/event\/athletics%3A9695$|\/map\/event\/athletics:9695$/)
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Men's Soccer vs Dartmouth")
  await expect(view.locator(".score")).toHaveText("T 0–0")
  await expect(view).toContainText("Final")
  await expect(view.getByRole("button", { name: /Directions|Save/ })).toHaveCount(0)
  await shoot(page, "sports-game")
})

test("search finds a sport's results, and the page of them all", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/")
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("football")
  const found = page.getByRole("region", { name: "Sports" })
  await expect(found.locator(".score").first()).toHaveText("W 30–23")
  await shoot(page, "sports-search")
  await search.fill("scores")
  await found.getByRole("button", { name: /All scores/ }).tap()
  await expect(page).toHaveURL(/\/map\/sports$/)
})
