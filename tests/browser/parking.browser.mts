// Parking on the map, on a phone, from the build's parking areas, with no UNH holidays so the days picked never land
// on one: a weekday stay at B Lot from 6:30 to 8:30 is refused from 7; Thompson Hall refuses a class; the permit
// chosen in the sheet's fields changes a verdict and is kept; on a winter night, only what's certain is said, and
// the rest links to UNH's winter rules; Directions for an event offers where to park for it; and search lists
// parking before anything Photon finds further off. Dates come from today, the winter's from the coming January.
// Screenshots go to NOTUNH_SHOTS when it's set

import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, open as openPage, shoot, startFixture } from "./fixture.mts"
import { emptyIndex } from "../../src/courses/course.mts"
import { fieldOf, segmentOf } from "../../src/map/link.mts"
import { type Day, addDays, atClock, localDay, weekday } from "../../src/shared/time.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York", serviceWorkers: "block" })


const today = localDay(Date.now())

/** The next Tuesday from tomorrow outside the winter season, 1 December to 1 April */
const tuesday = (() => {
  let day = addDays(today, 1)
  while (weekday(day) !== 1 || /^\d{4}-(12|01|02|03)-/.test(day))
    day = addDays(day, 1)
  return day
})()

/** The coming 15 January, deep in the ban */
const january: Day = `${+today.slice(0, 4) + (today.slice(5) >= "01-15" ? 1 : 0)}-01-15`

/** A parking page's link for a stay on a day, from and to times of Durham's clock */
const stayOn = (day: Day, from: string, to: string) =>
  `?arrive=${day}T${from}&leave=${to < from ? addDays(day, 1) : day}T${to}`

const open = async (page: Page, origin: string, path: string) => {
  // No holidays, so a weekday is a weekday whatever UNH's calendar says this year
  await page.route(/\/assets\/courses-[\w-]+\.json$/, route => route.fulfill({ json: emptyIndex() }))
  await openPage(page, origin, path)
}

test("B Lot from 6:30 to 8:30 on a weekday says a permit is required from 7 AM, and the sheet near Kingsbury ranks it", async ({ page, fixture }) => {
  await page.clock.setFixedTime(new Date(atClock(addDays(tuesday, -1), "18:00")))
  await open(page, fixture.origin, `/map/area/B${stayOn(tuesday, "06:30", "08:30")}`)
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { name: "B Lot" })).toBeVisible()
  // The page is the sheet's, with Back in place of the home
  await expect(page.getByPlaceholder("Search campus")).toBeHidden()
  await expect(page.getByRole("button", { name: "Back to Map" })).toBeVisible()
  await expect(view.locator(".view-when")).toHaveText("Doesn't fit")
  await expect(view.locator(".verdict")).toContainText(/permit required from 7 AM/i)
  await expect(view.locator(".verdict")).toContainText("open from 6 PM")
  await expect(view.locator(".line").first()).toContainText("faculty/staff permit")
  await expect(view.getByText("Zone 98714 ›")).toBeVisible()
  await shoot(page, "parking-area")

  // The sheet for a class at Kingsbury: what's asked in a line, the best few areas, each in words with whether it fits
  await page.goto(fixture.origin + `/map/parking/Kingsbury+Hall${stayOn(tuesday, "06:30", "08:30")}&for=class`)
  await expect(view.getByRole("heading", { name: "Parking near Kingsbury Hall" })).toBeVisible()
  const asked = view.locator(".parking-ask summary")
  await expect(asked).toContainText("6:30 – 8:30 AM")
  await expect(asked).toContainText("no permit · a class")
  await expect(view.getByLabel("Arrive")).toBeHidden()
  await asked.click()
  await expect(view.getByLabel("For", { exact: true })).toHaveValue("class")
  await expect(view.getByLabel("Arrive")).toHaveValue(`${tuesday}T06:30`)
  const rows = view.getByRole("list", { name: "Parking areas" }).locator("li")
  // The best five, and the nearest that doesn't fit, which says why not
  await expect(rows).toHaveCount(6)
  await expect(rows.first()).toContainText("Fits")
  await expect(rows.last()).toContainText("No")
  await expect(rows.last()).toContainText(/permit required from 7 AM/i)
  await shoot(page, "parking-sheet")

  // Leaving later changes the link in place, and a row opens its area for the same stay
  await view.getByLabel("Leave").fill(`${tuesday}T09:30`)
  await view.getByLabel("Leave").dispatchEvent("change")
  await expect(page).toHaveURL(new RegExp(`leave=${tuesday}T09:30`))
  await rows.first().getByRole("button").click()
  await expect(page).toHaveURL(new RegExp(`/map/area/.+leave=${tuesday}T09:30&for=class`))
})

test("Thompson Hall refuses a class outright, in words, and takes an errand", async ({ page, fixture }) => {
  await page.clock.setFixedTime(new Date(atClock(tuesday, "11:50")))
  await open(page, fixture.origin, `/map/area/t-hall${stayOn(tuesday, "12:00", "12:30")}&for=class`)
  const view = page.locator(".view")
  await expect(view.locator(".view-when")).toHaveText("Doesn't fit")
  await expect(view.locator(".verdict")).toContainText("Short errands only, not for class")
  await expect(view.getByRole("link", { name: "Pay · ParkMobile zone 98720" })).toHaveAttribute("href", "https://app.parkmobile.io/")
  await page.goto(fixture.origin + `/map/area/t-hall${stayOn(tuesday, "12:00", "12:30")}&for=errand`)
  await expect(view.locator(".view-when")).toHaveText("Fits")
})

test("the permit chosen in the sheet's fields changes a verdict, and is kept on the device", async ({ page, fixture }) => {
  await page.clock.setFixedTime(new Date(atClock(addDays(tuesday, -1), "18:00")))
  await open(page, fixture.origin, `/map/parking/Kingsbury+Hall${stayOn(tuesday, "06:30", "08:30")}`)
  const view = page.locator(".view")
  const asked = view.locator(".parking-ask summary")
  await expect(asked).toContainText("no permit")
  await asked.click()
  await view.getByLabel("Permit", { exact: true }).selectOption("faculty")
  await expect(asked).toContainText("faculty/staff")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("parking-permit"))).toBe(JSON.stringify("faculty"))

  await page.goto(fixture.origin + `/map/area/B${stayOn(tuesday, "06:30", "08:30")}`)
  await expect(view.locator(".view-when")).toHaveText("Fits")
  await expect(view.locator(".verdict")).toContainText("Your permit")

  await page.goto(fixture.origin + `/map/parking/Kingsbury+Hall${stayOn(tuesday, "06:30", "08:30")}`)
  await asked.click()
  await expect(view.getByLabel("Permit", { exact: true })).toHaveValue("faculty")
  await view.getByLabel("Permit", { exact: true }).selectOption("")
  await page.goto(fixture.origin + `/map/area/B${stayOn(tuesday, "06:30", "08:30")}`)
  await expect(view.locator(".view-when")).toHaveText("Doesn't fit")
})

test("on a winter night, B Lot isn't said to fit or not, it links to UNH's rules, and E Lot keeps its own permit holders", async ({ page, fixture }) => {
  await page.clock.setFixedTime(new Date(atClock(addDays(january, -1), "20:00")))
  await open(page, fixture.origin, `/map/area/B${stayOn(january, "00:30", "05:30")}`)
  const view = page.locator(".view")
  await expect(view.locator(".view-when")).toHaveText("Winter ban may apply")
  await expect(view.getByRole("link", { name: "UNH's winter rules ›" })).toHaveAttribute("href", "https://www.unh.edu/transportation/parking/information/winter-parking-ban")
  await expect(view.getByText("ban may apply, 12 – 7 AM")).toBeVisible()
  await shoot(page, "parking-winter")

  await page.evaluate(() => localStorage.setItem("parking-permit", JSON.stringify({ resident: "E" })))
  await page.goto(fixture.origin + `/map/area/E${stayOn(january, "00:30", "05:30")}`)
  await expect(view.locator(".view-when")).toHaveText("Fits")
  await expect(view.getByText("permit holders stay all night")).toBeVisible()
})

test("searching a lot's name opens its page, and searching parking opens the sheet", async ({ page, fixture }) => {
  await page.clock.setFixedTime(new Date(atClock(tuesday, "11:50")))
  await open(page, fixture.origin, "/map/")
  const to = page.getByPlaceholder("Search campus")
  await to.click()
  await to.fill("Sage Way")
  const found = page.getByRole("region", { name: "Parking" })
  await found.getByRole("button", { name: /Sage Way Visitor Lot/ }).click()
  await expect(page).toHaveURL(/\/map\/area\/sage-way$/)
  await expect(page.locator(".view").getByRole("heading", { name: "Sage Way Visitor Lot" })).toBeVisible()
  // Back is to the search, as it was typed
  await page.getByRole("button", { name: "Back to Search" }).click()
  await expect(to).toHaveValue("Sage Way")
  await to.fill("parking")
  await found.getByRole("button", { name: /^Parking/ }).click()
  await expect(page).toHaveURL(/\/map\/parking$/)
  await expect(page.locator(".view").getByRole("heading", { name: "Parking", exact: true })).toBeVisible()
})

test("Directions for an event offers where to park for it, for its whole stay, for an event", async ({ page, fixture }) => {
  // On the real clock, as the location's fixes are, a couple of hours on, today's or tomorrow's as it falls
  const start = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 2 * 3_600_000
  const event = { id: "25live:test", title: "Career Night", start, end: start + 75 * 60_000, place: "Kingsbury Hall", where: "N101", source: "25live", url: "https://example.edu" }
  await page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: { fetched: Date.now(), events: [event] } }))
  // On campus, so there's a trip to show
  await page.context().grantPermissions(["geolocation"])
  await page.context().setGeolocation({ latitude: 43.137, longitude: -70.933 })
  await open(page, fixture.origin, `/map/event/${segmentOf(event.id)}`)
  await expect(page.locator(".view").getByRole("heading", { name: "Career Night" })).toBeVisible()
  await page.getByRole("button", { name: "Directions" }).click()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await page.getByRole("button", { name: "Parking ›" }).click()
  // From half an hour before it to a quarter after it ends
  await expect(page).toHaveURL(`${fixture.origin}/map/parking/Kingsbury+Hall?arrive=${fieldOf(start - 30 * 60_000)}&leave=${fieldOf(event.end + 15 * 60_000)}&for=event`)
  await expect(page.locator(".view").getByRole("heading", { name: "Parking near Kingsbury Hall" })).toBeVisible()
})

test("searching a lot lists the parking the map knows before the far-off places Photon finds", async ({ page, fixture }) => {
  await page.clock.setFixedTime(new Date(atClock(tuesday, "11:50")))
  await page.route(/photon\.komoot\.io\/api/, route => route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-70.76, 43.07] }, properties: { name: "Long-Term Parking Lot B", city: "Portsmouth", osm_key: "amenity", osm_value: "parking" } }] } }))
  await open(page, fixture.origin, "/map/")
  const to = page.getByPlaceholder("Search campus")
  await to.click()
  await to.fill("B Lot")
  const parking = page.getByRole("region", { name: "Parking" })
  const further = page.getByRole("listbox", { name: "Further off" })
  await expect(parking.getByRole("button", { name: /^B Lot/ })).toBeVisible()
  await expect(further).toContainText("Long-Term Parking Lot B")
  expect(await parking.evaluate((group, list) => !!(group.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING), await further.elementHandle())).toBe(true)
})
