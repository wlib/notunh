// Searching for where from and where to on a phone, in directions: a tap chooses, a drag only scrolls, and a trip
// never suggests going from somewhere to itself

import { test as base, expect, devices } from "@playwright/test"
import { type Fixture, open, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// A phone, with every other origin, like Umo and the map's tiles, out of reach
const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })

test("a tap on a suggestion chooses it, a drag over one doesn't, and the trip's other end isn't suggested", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/directions")
  const [from, to] = [page.getByPlaceholder("Search or tap the map"), page.getByPlaceholder("Where to?")]
  const options = page.getByRole("option")

  await from.click()
  await from.fill("Holloway")
  const holloway = options.filter({ hasText: "Holloway" }).first()
  const name = (await holloway.textContent())!
  // A drag starts as a tap would, but the browser cancels it to scroll
  await holloway.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true })
  await holloway.dispatchEvent("pointercancel", { pointerType: "touch", isPrimary: true })
  await expect(from).toBeFocused()
  await holloway.tap()
  await expect(from).toHaveValue(name)

  await to.click()
  await to.fill("Holloway")
  await expect(options.first()).toBeVisible()
  await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0)
  await to.fill("Kingsbury Hall")
  await page.getByRole("option", { name: "Kingsbury Hall", exact: true }).tap()

  // What's been chosen before is suggested before anything's typed, but for the other end
  await from.click()
  await expect(page.getByRole("option", { name, exact: true })).toHaveCount(1)
  await expect(page.getByRole("option", { name: "Kingsbury Hall", exact: true })).toHaveCount(0)
})

test("Clear empties a field, what's typed and the place chosen alike, and the search with it, keeping the field to type in", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/")
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("Kings")
  await expect(page.getByRole("option", { name: "Kingsbury Hall", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search" }).tap()
  await expect(search).toHaveValue("")
  await expect(search).toBeFocused()
  await expect(page.locator(".suggested")).toHaveCount(0)

  await page.goto(fixture.origin + "/map/directions")
  const to = page.getByPlaceholder("Where to?")
  await to.fill("Kingsbury Hall")
  await page.getByRole("option", { name: "Kingsbury Hall", exact: true }).tap()
  await expect(to).toHaveValue("Kingsbury Hall")
  // Chosen, then typed over and cleared while still typing
  await to.tap()
  await to.fill("Holl")
  await page.getByRole("button", { name: "Clear to" }).tap()
  await expect(to).toHaveValue("")
  await expect(to).toBeFocused()
  await expect(page.getByRole("option", { name: /Holloway/ })).toHaveCount(0)
  await to.blur()
  await expect(to).toHaveValue("")
})

test("a touch on what a field offers takes it, though it keeps the field focused till then: a place for an event, and a search's result", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/new")
  const where = page.locator("input[name=place]")
  await where.tap()
  await where.fill("Thompson")
  await page.getByRole("option", { name: "Thompson Hall", exact: true }).tap()
  await expect(where).toHaveValue("Thompson Hall")
  await expect(page.getByRole("option")).toHaveCount(0)

  await page.goto(fixture.origin + "/map/")
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("parking")
  await page.getByRole("region", { name: "Parking" }).getByRole("button").first().tap()
  await expect(page).toHaveURL(/\/map\/parking/)
})
