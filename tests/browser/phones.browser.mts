// The phone numbers on a phone: found from Campus and from search, each a link that calls, emergency first; and in
// directions, UNH Police's walking escort where no bus goes between two places on campus

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

test("Campus opens the numbers, emergency first, each a link that calls", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/")
  await page.getByRole("list", { name: "Campus" }).getByRole("button", { name: /Phone numbers/ }).click()
  await expect(page).toHaveURL(/\/map\/phones$/)
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Phone numbers")
  const calls = view.locator("a[href^='tel:']")
  await expect(calls.first()).toHaveAttribute("href", "tel:911")
  await expect(calls.nth(1)).toHaveAttribute("href", "tel:+16038621427")
  await shoot(page, "phones")
})

test("search finds a number by what it's for, calling it from the results, and the page of them all", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/")
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("police")
  const found = page.getByRole("region", { name: "Phone numbers" })
  await expect(found.locator("a[href='tel:+16038621427']")).toContainText("(603) 862-1427")
  await shoot(page, "phones-search")
  await found.getByRole("button", { name: /All phone numbers/ }).tap()
  await expect(page).toHaveURL(/\/map\/phones$/)
})

test("with no bus between two places on campus at night, directions offer the walking escort, which calls dispatch", async ({ page, fixture }) => {
  // A quarter to three in the morning, long after the last bus, a day the fixtures' timetable may or may not run
  await page.clock.setFixedTime(new Date("2026-10-08T06:45:00Z"))
  await open(page, fixture.origin, "/map/directions")
  const [from, to] = [page.getByPlaceholder("Search or tap the map"), page.getByPlaceholder("Where to?")]
  await from.click()
  await from.fill("Gables N")
  await page.getByRole("option", { name: "Gables N", exact: true }).tap()
  await to.click()
  await to.fill("Kingsbury Hall")
  await page.getByRole("option", { name: "Kingsbury Hall", exact: true }).tap()
  const escort = page.locator(".escort")
  await expect(escort).toContainText("walking escort")
  await expect(escort.locator("a")).toHaveAttribute("href", "tel:+16038621427")
  await shoot(page, "phones-escort")
})
