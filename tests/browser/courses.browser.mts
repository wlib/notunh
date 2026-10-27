// The courses on the map, on a phone, from the courses' fixtures (tests/courses/fixtures.mts) moved by whole weeks so
// their term is under way this week, and the clock set to this week's Tuesday: searching an instructor's name answers
// with their next class and its room; a section's page leads with its next meeting; saving a section puts it in
// Yours and You's week; and Remind on an instructor's class is set with nothing saved. Screenshots go to
// NOTUNH_SHOTS when it's set

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect, devices, type BrowserContext, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"
import type { CoursesIndex, Section, TermFile } from "../../src/courses/course.mts"
import { emptyCalendar } from "../../src/courses/calendar.mts"
import { addDays, atClock, daysBetween, localDay, weekday } from "../../src/shared/time.mts"
import { fall } from "../courses/fixtures.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

const { defaultBrowserType, ...phone } = devices["iPhone 13"]
// Without the service worker, whose own fetches a page's routes can't answer, but for Remind, which needs it
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York", serviceWorkers: "block" })

const SHOTS = process.env.NOTUNH_SHOTS
if (SHOTS)
  mkdirSync(SHOTS, { recursive: true })
const shoot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: join(SHOTS, `${name}-${test.info().project.name}.png`) }) : Promise.resolve()

/** This week's Monday, which the fall fixture's eighth week is moved to, so the term is under way whenever this runs */
const monday = addDays(localDay(Date.now()), -weekday(localDay(Date.now())))
const shift = daysBetween(addDays(fall.from, 49), monday)
const moved = (day: string) => addDays(day, shift)

const FILE = "/data/courses/fixture.json"
const sections: Section[] = fall.sections.map(section => ({
  ...section,
  from:     moved(section.from),
  to:       moved(section.to),
  meetings: section.meetings.map(meeting => ({ ...meeting, from: moved(meeting.from), to: moved(meeting.to) }))
}))
const term: TermFile = { code: fall.code, sections }
const index: CoursesIndex = {
  built:    Date.now(),
  // No holidays nor swaps, which wouldn't fall where the weeks moved to
  calendar: { ...emptyCalendar(), terms: { [fall.code]: { name: fall.name, start: moved(fall.from), end: moved(fall.to), reading: [] } } },
  terms:    [{ code: fall.code, name: fall.name, from: moved(fall.from), to: moved(fall.to), fetched: Date.now() - 3_600_000, sections: sections.length, file: FILE }],
  files:    [FILE]
}

/** The page, or every page of a context and in Chromium its service worker, served the moved fixtures in place of the build's courses */
const serveCourses = async (target: Page | BrowserContext) => {
  await target.route(/\/assets\/courses-[\w-]+\.json$/, route => route.fulfill({ json: index }))
  await target.route(`**${FILE}`, route => route.fulfill({ json: term }))
}

/** This week's Tuesday at a time, as the design's scene is */
const tuesday = (time: string) =>
  new Date(atClock(addDays(monday, 1), time))

const open = async (page: Page, origin: string, path = "/map/") => {
  await page.goto(origin + path)
  const no = page.getByRole("button", { name: "No", exact: true })
  await no.waitFor({ timeout: 3000 }).then(() => no.click(), () => {})
}

test("searching an instructor's name answers with a row holding their next class and its room, and Directions", async ({ page, fixture }) => {
  await page.clock.setFixedTime(tuesday("13:40"))
  await serveCourses(page)
  await open(page, fixture.origin)
  await page.getByPlaceholder("Search campus").click()
  await page.getByPlaceholder("Search campus").fill("Benedetto")
  const row = page.getByRole("region", { name: "Instructors" }).locator("li", { hasText: "David Benedetto" })
  await expect(row).toContainText("Next class")
  await expect(row).toContainText("Kingsbury N343")
  await expect(row).toContainText("CS 518")
  await expect(row.getByRole("button", { name: "Directions ›" })).toBeVisible()
  await shoot(page, "search-instructor")

  // His page lists every section he teaches this week, Friday's room said to differ, and email last
  await row.getByRole("button", { name: /David Benedetto/ }).click()
  await expect(page).toHaveURL(/\/map\/\?person=/)
  await expect(page.locator(".view-label", { hasText: "Next" })).toBeVisible()
  await expect(page.locator(".view .rows")).toContainText("IT 791 (01)")
  await expect(page.locator(".view .rows")).toContainText("Kingsbury N113 · different room")
  await expect(page.locator(".view .line").last()).toContainText("Email")
  // No address anywhere, but You's placeholder for your own
  expect(await page.content()).not.toMatch(/mailto:|(?<!"you)@\w+\.edu/)
})

test("a section's page, at its own link, leads with its next meeting, then Directions, Save and Share", async ({ page, fixture }) => {
  await page.clock.setFixedTime(tuesday("13:40"))
  await serveCourses(page)
  await open(page, fixture.origin, "/map/?section=202610:12496")
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { name: "Introduction to Software Engineering" })).toBeVisible()
  await expect(view.locator(".view-label").first()).toHaveText("Next")
  await expect(view.locator(".view-when").first()).toContainText("Today")
  await expect(view.locator(".view-facts").first()).toContainText("Kingsbury N343")
  await expect(view.locator(".view-actions .button")).toHaveText(["Directions", "Save", "Share"])
  await expect(view.locator(".line").first()).toContainText("N113")
  await shoot(page, "section")

  // Directions plans getting there by its start, and Back comes back to the page
  await view.getByRole("button", { name: "Directions" }).click()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await expect(page.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "true")
  await page.goBack()
  await expect(page).toHaveURL(/section=202610:12496/)
  await expect(view.getByRole("heading", { name: "Introduction to Software Engineering" })).toBeVisible()
})

test("a section saved is your next class in Yours and in You's week, once whichever of a cross-listed pair is saved", async ({ page, fixture }) => {
  await page.clock.setFixedTime(tuesday("09:00"))
  await serveCourses(page)
  await open(page, fixture.origin, "/map/?section=202610:12496")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Back" }).click()

  const yours = page.getByRole("list", { name: "Yours" })
  await expect(yours).toContainText("CS 518 · Kingsbury N343")
  await page.getByRole("button", { name: "You", exact: true }).click()
  await expect(page.getByText("My courses · 1")).toBeVisible()
  const week = page.getByLabel("Your week")
  await expect(week.locator(".week-class")).toHaveCount(3)
  await expect(week).toContainText("N113")
  await page.getByRole("button", { name: "Add to calendar" }).scrollIntoViewIfNeeded()
  await shoot(page, "my-courses")

  // A pair cross-listed with each other, pasted, is one class
  const pair = fall.sections.find(section => section.crossListed.some(crn => fall.sections.some(other => other.crn === crn)) && section.meetings.some(meeting => meeting.days))!
  await page.getByLabel("Your schedule, pasted").fill(`${pair.crn} ${pair.crossListed[0]}`)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("My courses · 2")).toBeVisible()
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("courses-saved")!))).toHaveLength(2)
})

test.describe(() => {
  test.use({ serviceWorkers: "allow" })

  test("Remind on an instructor's next class is set with nothing saved", async ({ page, context, fixture, browserName }) => {
    test.skip(browserName !== "chromium", "Only Chromium's push can be stubbed this way")
    await page.clock.setFixedTime(tuesday("08:00"))
    // As tests/browser/push.browser.mts stubs them: no push service in headless Chromium, and a Worker that takes it
    await context.addInitScript(() => {
      Object.defineProperty(Notification, "permission", { get: () => "granted" })
      const subscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/stub", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6", auth: "BTBZMqHH6r4Tts7J_aSIgg" } }) } as unknown as PushSubscription
      PushManager.prototype.subscribe = async () => subscription
      PushManager.prototype.getSubscription = async () => subscription
    })
    const watched: unknown[] = []
    await context.route("**/api/push/key", route => route.fulfill({ json: { key: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" } }))
    await context.route("**/api/reminders/**", async route => {
      watched.push(route.request().postDataJSON())
      await route.fulfill({ status: 204 })
    })
    await serveCourses(context)
    await open(page, fixture.origin)
    await page.getByPlaceholder("Search campus").click()
    await page.getByPlaceholder("Search campus").fill("Benedetto")
    await page.getByRole("button", { name: /David Benedetto/ }).click()
    await expect(page.locator(".view-label", { hasText: "Next" })).toBeVisible()
    await page.getByRole("button", { name: "Remind me", exact: true }).click()
    await expect(page.getByText("Reminder set")).toBeVisible()
    expect(watched.length).toBeGreaterThan(0)
    // The Worker hears a time and a place, never the class
    expect(JSON.stringify(watched)).not.toMatch(/CS \d{3}|Benedetto/)
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("courses-saved") ?? "[]"))).toEqual([])
  })
})
