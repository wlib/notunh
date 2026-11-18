// Calendars on a phone, against the Worker's app served from Node (tests/worker/serve.mts), with the clock set
// within the fixtures' fall term: a section's and a curated event's page add to a calendar and subscribe, by files
// the Worker serves; saved sections are a feed of your own, by a token made here and kept by the Worker; and a
// calendar imported from a file or a link shows in your week beside your classes, matched to them, and in Yours.
// Screenshots go to NOTUNH_SHOTS when it's set

import { readFileSync } from "node:fs"
import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, type Worker, open, shoot, startFixture, startWorker } from "./fixture.mts"
import { readEvents } from "../../src/shared/ics.mts"

let worker: Worker | undefined

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    worker ??= await startWorker(process.env.NOTUNH_DIST!)
    const fixture = await startFixture(process.env.NOTUNH_DIST!, { worker: worker!.origin })
    await use(fixture)
    await fixture.close()
  }
})

test.afterAll(() => {
  worker?.process.kill()
  worker = undefined
})

const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York", serviceWorkers: "block" })

/** A Tuesday morning of the fixtures' fall term, when CS 518 (01), CRN 12496, next meets at 2:10 PM in Kingsbury N343 */
const TUESDAY = new Date("2026-10-27T10:00:00-04:00")
const SECTION = "/map/section/202610/12496"

const calendar = (name: string) =>
  readFileSync(new URL(`../fixtures/calendars/${name}`, import.meta.url), "utf8")

/** The sheet at its tallest, as dragging its grabber up takes it */
const raise = async (page: Page) => {
  const grabber = (await page.locator(".grabber").boundingBox())!
  await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + grabber.height / 2)
  await page.mouse.down()
  await page.mouse.move(grabber.x + grabber.width / 2, 80, { steps: 8 })
  await page.mouse.up()
}

test("a section's page adds its meetings to a calendar, as a file the Worker serves, or subscribed to; a curated event's adds itself, or its series", async ({ page, fixture }) => {
  await page.clock.setFixedTime(TUESDAY)
  await open(page, fixture.origin, SECTION)
  const links = page.locator(".line-links a")
  await expect(links).toHaveText(["Add ›", "Subscribe ›"])
  const path = "/api/calendar/section/202610/12496.ics"
  expect(await links.evaluateAll(all => all.map(link => link.getAttribute("href")))).toEqual([path, `webcal://${new URL(fixture.origin).host}${path}`])
  const file = await page.request.get(fixture.origin + path)
  expect(file.headers()["content-type"]).toBe("text/calendar; charset=utf-8")
  expect(file.headers()["content-disposition"]).toMatch(/^inline; filename="[a-z0-9-]+\.ics"$/)
  // Tuesdays and Thursdays in one room and Fridays in another, each a weekly rule to the term's end
  const events = readEvents(await file.text())
  expect(events.map(({ where, session }) => [where, session.start, session.end])).toEqual([["Kingsbury N343", "14:10", "15:30"], ["Kingsbury N113", "14:10", "15:30"]])
  await raise(page)
  await shoot(page, "calendar-section")

  await page.goto(`${fixture.origin}/map/event/curated:russian-conversation-hour-2026-10-30-1400`)
  expect(await links.evaluateAll(all => all.map(link => link.getAttribute("href")))).toEqual([
    "/api/calendar/event/curated%3Arussian-conversation-hour-2026-10-30-1400.ics",
    `webcal://${new URL(fixture.origin).host}/api/calendar/series/russian-conversation-hour.ics`
  ])
  const series = await (await page.request.get(`${fixture.origin}/api/calendar/series/russian-conversation-hour.ics`)).text()
  expect(series).toMatch(/RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=\d{8}T\d{6}Z/)
  const [one] = readEvents(await (await page.request.get(`${fixture.origin}/api/calendar/event/curated%3Arussian-conversation-hour-2026-10-30-1400.ics`)).text())
  expect(one).toMatchObject({ title: "Russian Conversation Hour", day: "2026-10-30", session: { start: "14:00", end: "15:00" } })
})

test("your saved sections are a feed of your own: Copy link makes its address, which a calendar app reads, and a new link ends the old", async ({ page, fixture }) => {
  await page.clock.setFixedTime(TUESDAY)
  await open(page, fixture.origin, SECTION)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.goto(`${fixture.origin}/map/you`)
  await page.getByRole("button", { name: "Copy link" }).click()
  const subscribe = page.getByRole("link", { name: "Subscribe" })
  await expect(subscribe).toHaveAttribute("href", /^webcal:\/\/[\d.:]+\/api\/calendar\/feed\/[\w-]{22}\.ics$/)
  const address = (await subscribe.getAttribute("href"))!.replace("webcal://", "http://")
  // Once New link is offered, the Worker has the token, as it's sent before the address is given out
  await expect(page.getByRole("button", { name: "New link" })).toBeVisible()
  await expect.poll(async () => (await page.request.get(address)).status()).toBe(200)
  const feed = await page.request.get(address)
  expect(feed.headers()["content-type"]).toBe("text/calendar; charset=utf-8")
  expect(feed.headers()["cache-control"]).toMatch(/^private/)
  expect(await feed.text()).toMatch(/^BEGIN:VCALENDAR\r\n/)
  await raise(page)
  await shoot(page, "calendar-feed")

  await page.getByRole("button", { name: "New link" }).click()
  await expect(page.getByText("New link made; the old one no longer works.")).toBeVisible()
  await expect(subscribe).not.toHaveAttribute("href", address.replace("http://", "webcal://"))
  expect((await page.request.get(address)).status()).toBe(404)
  expect((await page.request.get((await subscribe.getAttribute("href"))!.replace("webcal://", "http://"))).status()).toBe(200)
})

test("a calendar imported from a file or a link stays on the phone, and shows in your week matched to your classes, a saved one told once, and in Yours", async ({ page, fixture }) => {
  await page.clock.setFixedTime(TUESDAY)
  // Nothing of an imported calendar goes to the Worker: a link its host lets a page read is asked from here
  const sent: string[] = []
  page.on("request", request => request.url().includes("/api/calendar/fetch") && sent.push(request.url()))
  await page.route("https://calendar.example.org/feed.ics", route => route.fulfill({ body: calendar("outlook.ics"), contentType: "text/calendar", headers: { "access-control-allow-origin": "*" } }))
  await open(page, fixture.origin, SECTION)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.goto(`${fixture.origin}/map/you`)
  await page.locator("input[type=file]").setInputFiles({ name: "classes.ics", mimeType: "text/calendar", buffer: Buffer.from(calendar("google.ics")) })
  const calendars = page.getByRole("list", { name: "Calendars" }).getByRole("listitem")
  // As it reads, since a count carries both its singular and its plural, one of them shown
  await expect(calendars).toHaveText([/^Classes\s*7 events · 1 class found · read Oct 27$/], { useInnerText: true })
  await page.getByLabel("Calendar link").fill("webcal://calendar.example.org/feed.ics")
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(calendars).toHaveText([/^Classes\s*7 events/, /^Calendar\s*3 events · 1 class found/], { useInnerText: true })
  expect(sent).toEqual([])
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("calendars")!).map(({ url }: { url?: string }) => url ?? null))).toEqual([null, "https://calendar.example.org/feed.ics"])

  // Tuesday's CS 518 is saved and in the calendar too, and told once; the moved Thursday class is the calendar's alone
  const week = page.getByLabel("Your week")
  await expect(week.locator(".week-day").nth(1)).toHaveText(/^Tue12:00 PMCall home2:10 PMCS 518N343$/)
  await expect(week.locator(".week-day").nth(3)).toHaveText(/^Thu2:10 PMCS 518N3434:00 PMCS 518N113$/)
  await expect(week.locator(".week-day").nth(0)).toHaveText(/^Mon1:00 PMPSYC 401210$/)
  await raise(page)
  await week.scrollIntoViewIfNeeded()
  await shoot(page, "calendar-week")
  await page.getByRole("heading", { name: "My calendar" }).scrollIntoViewIfNeeded()
  await shoot(page, "calendar-import")
  await page.emulateMedia({ colorScheme: "dark" })
  await shoot(page, "calendar-import-dark")
  await page.emulateMedia({ colorScheme: "light" })

  // A class found in the calendar opens its section's page
  await week.getByRole("button", { name: /PSYC 401/ }).first().click()
  await expect(page).toHaveURL(/\/map\/section\/202610\/\d{5}$/)
  await page.goto(`${fixture.origin}/map/`)
  // What's in the calendar next today is the card that leads the day, said there alone, and the class after it is yours
  // in the day's list
  await expect(page.locator(".next")).toHaveText(/Call home12:00 PM · Your calendar$/)
  await expect(page.getByRole("list", { name: "Today" }).locator("li.yours")).toHaveText([/^2:10 PMCS 518 · Kingsbury N343/])

  // Removed, it's gone from the week and from the phone
  await page.goto(`${fixture.origin}/map/you`)
  await page.getByRole("button", { name: "Remove Classes" }).click()
  await page.getByRole("button", { name: "Remove Calendar" }).click()
  await expect(calendars).toHaveCount(0)
  await expect(week.locator(".week-day").nth(1)).toHaveText(/^Tue2:10 PMCS 518N343$/)
  expect(await page.evaluate(() => localStorage.getItem("calendars"))).toBe("[]")
})

test("a browser with no Temporal of its own loads the polyfill, once, and reads a calendar by it; one with its own never asks for it", async ({ page, fixture }) => {
  await page.clock.setFixedTime(TUESDAY)
  const polyfills = () => fixture.requests.filter(path => /^\/assets\/temporal-polyfill-[\w-]+\.js$/.test(path))
  await open(page, fixture.origin, "/map/you")
  await page.locator("input[type=file]").setInputFiles({ name: "classes.ics", mimeType: "text/calendar", buffer: Buffer.from(calendar("google.ics")) })
  const week = page.getByLabel("Your week")
  await expect(week.locator(".week-day").nth(1)).toHaveText(/^Tue12:00 PMCall home2:00 PMCS 518N343$/)
  expect(await page.evaluate(() => "Temporal" in globalThis)).toBe(true)
  expect(polyfills()).toEqual([])

  // As Safari before it had one: the page's own Temporal taken away before any of its code runs
  await page.addInitScript(() => {
    delete (globalThis as { Temporal?: unknown }).Temporal
  })
  await page.reload()
  await expect(week.locator(".week-day").nth(1)).toHaveText(/^Tue12:00 PMCall home2:00 PMCS 518N343$/)
  // The Thursday class moved two hours later is told then, and not at its usual time
  await expect(week.locator(".week-day").nth(3)).toHaveText(/^Thu4:00 PMCS 518N113$/)
  expect(await page.evaluate(() => "Temporal" in globalThis)).toBe(false)
  expect(polyfills()).toHaveLength(1)
  expect(await page.locator("link[rel=polyfill]").getAttribute("href")).toBe(polyfills()[0])
})

test("a link that's no calendar, or a file that isn't one, says so and keeps nothing", async ({ page, fixture }) => {
  await page.clock.setFixedTime(TUESDAY)
  await page.route("https://calendar.example.org/page", route => route.fulfill({ body: "<html>Sign in</html>", contentType: "text/html", headers: { "access-control-allow-origin": "*" } }))
  await open(page, fixture.origin, "/map/you")
  await page.getByLabel("Calendar link").fill("https://calendar.example.org/page")
  await page.getByRole("button", { name: "Add", exact: true }).click()
  // The Worker is asked, as the page's own ask got no calendar, and can't reach it either
  await expect(page.locator(".you-section", { hasText: "My calendar" }).getByRole("status")).toHaveText(/calendar/)
  await page.locator("input[type=file]").setInputFiles({ name: "notes.ics", mimeType: "text/calendar", buffer: Buffer.from("Dear diary") })
  await expect(page.locator(".you-section", { hasText: "My calendar" }).getByRole("status")).toHaveText("That file isn't a calendar.")
  await expect(page.getByRole("list", { name: "Calendars" })).toHaveCount(0)
})
