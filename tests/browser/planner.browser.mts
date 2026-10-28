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
