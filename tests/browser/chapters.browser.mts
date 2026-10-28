// The fraternities and sororities on a phone: a chapter found by a nickname or its letters opens its house's page,
// which says what it is and links to UNH's page for it, and one whose house the map doesn't place is found all the
// same, saying so

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

const open = async (page: Page, origin: string) => {
  await page.goto(origin + "/map/")
  const no = page.getByRole("button", { name: "No", exact: true })
  await no.waitFor({ timeout: 3000 }).then(() => no.click(), () => {})
}

test("a chapter's nickname finds its house, whose page says its letters, chapter and council, and links to UNH's page", async ({ page, fixture }) => {
  await open(page, fixture.origin)
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("sig chi")
  const option = page.getByRole("option").first()
  await expect(option).toHaveText("Sigma Chi")
  await option.tap()

  const view = page.locator(".view")
  await expect(view.getByRole("heading", { name: "Sigma Chi" })).toBeVisible()
  await expect(view.locator(".view-kind")).toHaveText("ΣΧ · Fraternity")
  await expect(view.locator(".view-facts").first()).toContainText("Lambda Sigma chapter")
  await expect(view.locator(".view-facts").first()).toContainText("Interfraternity Council")
  await expect(view.getByRole("link", { name: /UNH chapter page/ })).toHaveAttribute("href", /chapter-scorecards\/sigma-chi$/)
  await expect(page).toHaveURL(/\/map\/place\/Sigma\+Chi$/)
})

test("a chapter's letters and nickname find it, and one the map doesn't place is found by its nickname, saying so", async ({ page, fixture }) => {
  await open(page, fixture.origin)
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("ΑΧΩ")
  await expect(page.getByRole("option").first()).toHaveText("Alpha Chi Omega")

  await search.fill("pike")
  await expect(page.getByRole("option").first()).toHaveText("Pi Kappa Alpha")

  await search.fill("teke")
  const found = page.getByRole("region", { name: "Fraternities and sororities" })
  await expect(found.getByRole("link").first()).toContainText("Tau Kappa Epsilon")
  await expect(found.getByRole("link").first()).toContainText("No house on the map")
})
