// Saves on a phone, against the Worker's app served from Node (tests/worker/serve.mts): a club's meeting saved from
// today's list is that meeting alone, in Yours, and next week's isn't; the notice offers to follow the club, which its
// page then says; and a laptop linked to the phone shows the same save and follow, kept for the person by the Worker.
// Screenshots go to NOTUNH_SHOTS when it's set

import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, type Worker, open, shoot, startFixture, startWorker } from "./fixture.mts"
import { atClock, localDay } from "../../src/shared/time.mts"

/** The Worker's app, started once for every test this process runs of this file, for each browser in turn */
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
// Every other origin out of reach, and no service worker, which would answer the events from its copy rather than the
// route
const away = { proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York", serviceWorkers: "block" as const }
test.use({ ...phone, ...away })

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR

/** A club meeting an hour from now and again in a week, and a game in two hours, as the build's events */
const listed = (page: Page, now: number) =>
  page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: { fetched: now, events: [
    { id: `presence:hillel/meeting/${localDay(now + HOUR)}`, title: "Hillel meeting", start: now + HOUR, end: now + 2 * HOUR, place: "Thompson Hall", where: "Thompson Hall", source: "presence", url: "https://unh.presence.io/organization/hillel" },
    { id: `presence:hillel/meeting/${localDay(now + HOUR + WEEK)}`, title: "Hillel meeting", start: now + HOUR + WEEK, end: now + 2 * HOUR + WEEK, place: "Thompson Hall", where: "Thompson Hall", source: "presence", url: "https://unh.presence.io/organization/hillel" },
    { id: "athletics:1", title: "UNH Men's Ice Hockey vs UConn", start: now + 2 * HOUR, end: now + 5 * HOUR, place: "Thompson Hall", where: "Whittemore Center", source: "athletics", url: "https://unhwildcats.com" }
  ] } }))

/** A code shown on one device, typed on another, as linking is */
const CODE = /^[2-9A-Z]{4}-[2-9A-Z]{4}$/

/** A day's weekday as a save's label says it */
const weekdayOf = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" }).format(ms)

test("a club's meeting saved from today's list is that meeting alone, in Yours, the club followed from the notice, and both show on a linked device", async ({ page, browser, fixture }) => {
  test.slow()
  const now = atClock(localDay(Date.now()), "12:00")
  await page.clock.setFixedTime(now)
  await listed(page, now)
  await open(page, fixture.origin)
  const save = page.getByRole("button", { name: `Save Hillel meeting on ${weekdayOf(now + HOUR)}` }).first()
  await expect(save).toHaveAttribute("aria-pressed", "false")
  const sent = page.waitForResponse(response => response.url().endsWith("/api/state") && response.request().postData()?.includes("events-saved") === true)
  await save.click()
  await expect(save).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("status").filter({ hasText: `Saved ${weekdayOf(now + HOUR)}` })).toBeVisible()
  await sent
  await expect(page.getByRole("list", { name: "Yours" }).getByText("Hillel meeting")).toBeVisible()
  await shoot(page, "saved")
  // Next week's meeting isn't saved by it
  await page.goto(`${fixture.origin}/map/event/${encodeURIComponent(`presence:hillel/meeting/${localDay(now + HOUR + WEEK)}`)}`)
  await expect(page.locator(".save-button")).toHaveAttribute("aria-pressed", "false")
  // Following the club is the club's page's to do, and its page says so
  await page.goto(`${fixture.origin}/map/activity/presence:hillel`)
  const followed = page.waitForResponse(response => response.url().endsWith("/api/state") && response.request().postData()?.includes("presence:hillel") === true)
  await page.getByRole("button", { name: "Follow Hillel" }).click()
  await expect(page.getByRole("button", { name: "Following Hillel" })).toHaveAttribute("aria-pressed", "true")
  await followed

  // A laptop, linked to the phone, takes its saves and follows
  const other = await browser.newContext({ ...phone, ...away })
  const laptop = await other.newPage()
  await laptop.clock.setFixedTime(now)
  await listed(laptop, now)
  await open(laptop, fixture.origin)
  await expect(laptop.getByRole("button", { name: /^Save Hillel meeting/ }).first()).toHaveAttribute("aria-pressed", "false")
  await laptop.getByRole("button", { name: "You", exact: true }).click()
  await laptop.getByRole("button", { name: "Show a code on this device" }).click()
  await expect(laptop.locator(".code")).toHaveText(CODE)
  const code = (await laptop.locator(".code").textContent())!
  await page.goto(`${fixture.origin}/map/#link=${code.replace("-", "").toLowerCase()}`)
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByText("Approved.")).toBeVisible()
  await laptop.bringToFront()
  await laptop.evaluate(() => dispatchEvent(new FocusEvent("focus")))
  await expect(laptop.getByText("Linked.")).toBeVisible()
  await laptop.getByRole("button", { name: "Back to Map" }).click()
  await expect(laptop.getByRole("button", { name: `Save Hillel meeting on ${weekdayOf(now + HOUR)}` }).first()).toHaveAttribute("aria-pressed", "true")
  await laptop.goto(`${fixture.origin}/map/activity/presence:hillel`)
  await expect(laptop.getByRole("button", { name: "Following Hillel" })).toBeVisible()
  const button = laptop.getByRole("button", { name: "Following Hillel" })
  for (const colorScheme of ["light", "dark"] as const) {
    await laptop.emulateMedia({ colorScheme })
    const colors = await button.evaluate(element => {
      const style = getComputedStyle(element)
      return [style.color, style.backgroundColor]
    })
    expect(colors[0]).not.toBe(colors[1])
    await shoot(laptop, `saved-linked-${colorScheme}`)
  }
  await other.close()
})

test("Plan ahead shows a saved game once and activity filters show the matching session", async ({ page, fixture }) => {
  const now = atClock(localDay(Date.now()), "12:00")
  const events = [
    ...[1, 6, 6 + 7 * 24].map((hours, i) => ({
      id: `rec:yoga-${i}`, title: "Yoga", source: "rec", url: "https://crec.unh.edu/?courseId=yoga",
      start: now + hours * HOUR, end: now + (hours + 1) * HOUR, where: `Studio ${i + 1}`, left: 5
    })),
    ...["Maine", "Vermont"].map((name, i) => ({
      id: `athletics:${i}`, title: name, source: "athletics", url: "", where: "Arena",
      start: now + WEEK + i * HOUR, end: now + WEEK + (i + 1) * HOUR
    }))
  ]
  await page.clock.setFixedTime(now)
  await page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: { events, fetched: now } }))
  await page.addInitScript(end => localStorage.setItem("events-saved", JSON.stringify({
    sessions: { "athletics:0": end }, follows: ["rec:yoga"]
  })), now + WEEK + HOUR)
  await open(page, fixture.origin)
  const preview = page.locator(".home .ahead")
  await expect(preview.getByText("Maine", { exact: true })).toHaveCount(1)
  await expect(preview.getByText("Vermont", { exact: true })).toHaveCount(1)
  expect(await preview.locator("li").count()).toBeLessThanOrEqual(3)
  await page.getByRole("button", { name: /Clubs & activities/ }).click()
  await page.getByRole("button", { name: "Meets today" }).click()
  await page.getByLabel("Time of day").selectOption("evening")
  const rows = page.locator(".view .row").filter({ hasText: "Yoga" })
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText("Studio 2")
  await page.getByRole("button", { name: "Drop-in" }).click()
  await expect(rows).toHaveCount(0)
})
