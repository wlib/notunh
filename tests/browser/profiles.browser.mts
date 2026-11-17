// Buildings' profiles on a phone (src/map/ui/Profile.tsx), from the records in src/places/profiles/: a building found
// by another name, its page saying its category, when it was built, its rating, verdict and scores, its facts citing
// their sources, more to read, and its photos, each credited, opening a viewer over the screen; one closed without
// photos says so; one unrated has a verdict and no rating. Photos are asked of the Worker, a tile's narrower than the
// viewer's, never of Wikimedia or Flickr; with no Worker here, as offline, each tile says what it shows instead

import { test as base, expect, devices } from "@playwright/test"
import { type Fixture, open, shoot, startFixture } from "./fixture.mts"
import { photoSrc } from "../../src/places/profiles.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// A rating as a page says it, whatever the records score now: "7.9 of 10 · 4th of 103"
const RATING = /^\d+(\.\d)? of 10 · \d+(st|nd|rd|th) of \d+( · low confidence)?$/

// Thompson Hall's first photo, as its record has it
const SUNSET = "https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0a/Thompson_Hall%2C_UNH_Sunset.jpg/1280px-Thompson_Hall%2C_UNH_Sunset.jpg"

// A phone, with every other origin, like Umo, the map's tiles, Wikimedia and Flickr, out of reach
const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, viewport: { width: 390, height: 844 }, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York" })

test("a building found by its nickname shows its category, when it was built, its rating, verdict and scores, cited facts, more to read, and photos credited, opening a viewer", async ({ page, fixture }) => {
  await open(page, fixture.origin)
  const search = page.getByPlaceholder("Search campus")
  await search.tap()
  await search.fill("T-Hall")
  await page.getByRole("option").first().tap()
  await expect(page).toHaveURL(/\/map\/place\/Thompson\+Hall$/)

  const view = page.locator(".view")
  await expect(view.locator(".view-kind")).toHaveText("Administration")
  await expect(view.locator(".view-facts").first()).toContainText("Built 1893 · renovated 2007")
  await expect(view.locator(".rating")).toHaveText(RATING)
  await expect(view.locator(".verdict")).toContainText("The campus's landmark")
  await expect(view.locator(".scores dt")).toHaveText(["exterior", "interior", "character", "condition", "function", "reputation"])
  await expect(view.locator(".scores dd")).toHaveText(Array(6).fill(/^\d+$/))

  // Each photo's tile is its size before it loads, and here never loads, so says what it shows
  const tiles = view.locator(".photo-strip .shot")
  await expect(tiles).toHaveCount(6)
  await expect(tiles.first().locator("img")).toHaveAttribute("src", photoSrc(SUNSET, 500))
  await expect(tiles.first().locator("img")).toBeHidden()
  await expect(tiles.first()).toContainText("Main facade and tower from the lawn in evening light")
  const box = await tiles.first().boundingBox()
  expect(box!.width / box!.height).toBeCloseTo(4 / 3, 1)
  const credits = view.locator(".credits")
  await expect(credits.getByRole("link", { name: "AcrossTheAtlantic" })).toHaveCount(1)
  await expect(credits.getByRole("link", { name: "Mark Bonica" })).toHaveAttribute("href", "https://www.flickr.com/photos/23119666@N03/45928980612")

  const facts = view.locator(".facts li")
  await expect(facts).toHaveCount(6)
  await expect(facts.first()).toContainText("Named for Benjamin Thompson")
  await expect(facts.first().getByRole("link", { name: "UNH Library Archives" })).toHaveAttribute("href", "https://library.unh.edu/find/archives/buildings/administrative-and-campus-life")
  await expect(facts.first().getByRole("link", { name: "Wikipedia" })).toHaveAttribute("target", "_blank")
  await expect(view.getByRole("link", { name: /Wikipedia: Thompson Hall/ })).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Thompson_Hall_(University_of_New_Hampshire)")
  await shoot(page, "profile")

  await tiles.nth(2).tap()
  const viewer = page.getByRole("dialog", { name: "Photos of Thompson Hall" })
  await expect(viewer).toBeVisible()
  await expect(viewer.locator("img").first()).toHaveAttribute("src", photoSrc(SUNSET, 1280))
  const shown = viewer.locator("figure").nth(2)
  await expect(shown).toBeInViewport()
  await expect(shown.locator("figcaption")).toContainText("Tower, turret and porte-cochere arch in early spring, 2018")
  await expect(shown.getByRole("link", { name: "Meghan Murphy / UNHDigitalSandbox (Flickr)" })).toHaveAttribute("href", "https://www.flickr.com/photos/139546745@N02/39495700970")
  await expect(shown.getByRole("link", { name: "CC BY 2.0" })).toHaveAttribute("href", "https://creativecommons.org/licenses/by/2.0/")
  await shoot(page, "profile-viewer")
  await viewer.getByRole("button", { name: "Close" }).tap()
  await expect(viewer).toBeHidden()
  await expect(page).toHaveURL(/\/map\/place\/Thompson\+Hall$/)
})

test("a closed hall without photos says it's closed, and a field has a verdict but no rating", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/place/Eaton+House")
  const view = page.locator(".view")
  await expect(view.locator(".view-kind")).toHaveText("Residence hall")
  await expect(view.locator(".view-facts").nth(1)).toHaveText("Closed: Minis closed at the end of spring 2026; future not announced")
  await expect(view.locator(".rating")).toHaveText(RATING)
  await expect(view.locator(".photo-strip")).toHaveCount(0)
  await shoot(page, "profile-closed")

  await open(page, fixture.origin, "/map/place/Bremner+Field")
  await expect(view.locator(".view-kind")).toHaveText("Athletics")
  await expect(view.locator(".verdict")).toContainText("A lit synthetic-turf field")
  await expect(view.locator(".rating")).toHaveCount(0)
  await expect(view.locator(".scores")).toHaveCount(0)
})
