// Final exams on a phone, against the Worker's app served from Node (tests/worker/serve.mts), which holds the fall
// fixture's made-up finals (tests/fixtures/finals.mts) as the nightly run would store them, moved by whole weeks with
// the courses so their term is under way this week. A device with no verified UNH address sees no exam time or room on
// a section's page, only how to see them, and forgets any it had kept; once its address is verified, the page has the
// section's final and its room, and You lists your saved sections' finals. Screenshots go to NOTUNH_SHOTS when it's
// set, from WebKit, light and dark

import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, type Worker, SHOTS, open, shoot, startFixture, startWorker } from "./fixture.mts"
import { type CoursesIndex, type Section, type TermFile } from "../../src/courses/course.mts"
import { emptyCalendar } from "../../src/courses/calendar.mts"
import type { Finals } from "../../src/courses/finals.mts"
import { addDays, daysBetween, localDay, weekday } from "../../src/shared/time.mts"
import { fall, fallFinals } from "../courses/fixtures.mts"

/** What the Worker served for the tests takes as its build token (tests/worker/serve.mts) */
const BUILD_TOKEN = "build-token-for-browser-tests"

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
  calendar: { ...emptyCalendar(), terms: { [fall.code]: { name: fall.name, start: moved(fall.from), end: moved(fall.to), reading: [], finals: [moved("2026-12-15"), moved("2026-12-22")] } } },
  terms:    [{ code: fall.code, name: fall.name, from: moved(fall.from), to: moved(fall.to), fetched: Date.now() - 3_600_000, sections: sections.length, file: FILE }],
  files:    [FILE]
}

/** The fixture's finals as the nightly run stores them, moved with the term */
const finals: Finals = {
  version: 1,
  through: localDay(Date.now()),
  terms:   { [fall.code]: { name: fall.name, source: "https://example.org/sheet", fetched: Date.now(), finals: Object.fromEntries(Object.entries(fallFinals).map(([crn, sittings]) => [crn, sittings.map(final => ({ ...final, day: moved(final.day) }))])) } }
}

const serveCourses = async (page: Page) => {
  await page.route(/\/assets\/courses-[\w-]+\.json$/, route => route.fulfill({ json: index }))
  await page.route(`**${FILE}`, route => route.fulfill({ json: term }))
}

/** CS 518's page, whose final the fixture puts in its own room, Kingsbury N343 */
const CS518 = `/map/section/${fall.code}/12496`

/** The final's line on a section's page */
const finalLine = (page: Page) =>
  page.locator(".line", { has: page.locator("span", { hasText: /^Final/ }) })

const shootBoth = async (page: Page, name: string) => {
  if (!SHOTS || test.info().project.name !== "webkit")
    return
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await shoot(page, `${name}-${colorScheme}`)
  }
  await page.emulateMedia({ colorScheme: null })
}

test("a section's final is shown only once this device's UNH email is verified, and then your finals are in You", async ({ page, fixture }) => {
  test.slow()
  const stored = await fetch(`${worker!.origin}/api/models/finals`, { method: "POST", headers: { authorization: `Bearer ${BUILD_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ expect: null, state: finals }) })
  expect(stored.status).toBe(204)
  await serveCourses(page)

  // Unverified, the page has no exam time or room, only where to verify, and the Worker refuses this device the term
  await open(page, fixture.origin, CS518)
  await expect(finalLine(page)).toContainText("Verify your UNH email in You for its time and room")
  expect(await page.evaluate(code => fetch(`/api/finals/${code}`).then(response => response.status), fall.code)).toBe(403)
  await expect(page.getByText("One of")).toHaveCount(0)

  // Finals kept here from when the device was verified are forgotten once the Worker says it isn't
  await page.evaluate(kept => localStorage.setItem("finals", JSON.stringify(kept)), { [fall.code]: { code: fall.code, fetched: 1, finals: finals.terms[fall.code].finals } })
  await open(page, fixture.origin, CS518)
  await expect(finalLine(page)).toContainText("Verify your UNH email in You for its time and room")
  await expect(finalLine(page)).not.toContainText("Kingsbury N343")
  expect(await page.evaluate(() => localStorage.getItem("finals"))).toBe("{}")

  // Saved, then verified in You
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await finalLine(page).getByRole("button", { name: "You" }).click()
  await page.getByLabel("UNH email").fill("wildcat@unh.edu")
  await page.getByRole("button", { name: "Send code" }).click()
  await expect(page.getByText("Code sent to wildcat@unh.edu")).toBeVisible()
  const mail = await (await fetch(`${worker!.origin}/__mail`)).json() as { subject: string }
  await page.getByLabel("Code from the email").fill(mail.subject.slice(0, 6))
  await page.getByRole("button", { name: "Confirm" }).click()
  await expect(page.getByText("Verified as")).toBeVisible()

  // You lists CS 518's final, in its room
  const yours = page.getByRole("list", { name: "Your finals" })
  await expect(yours).toContainText("CS 518 (01) · Final")
  await expect(yours).toContainText("Kingsbury N343")
  await yours.scrollIntoViewIfNeeded()
  await shootBoth(page, "you-finals")

  // Its page has the final, its day and its room, which opens the room's page
  await open(page, fixture.origin, CS518)
  const line = finalLine(page)
  await expect(line).toContainText("Kingsbury N343")
  await expect(line).not.toContainText("Verify")
  await line.scrollIntoViewIfNeeded()
  await shootBoth(page, "section-final")

  // A common exam is in one of its rooms
  await open(page, fixture.origin, `/map/section/${fall.code}/10114`)
  const common = finalLine(page)
  await expect(common).toContainText("One of")
  for (const room of ["Horton B04", "Murkland 115", "Spaulding Life Science 145"])
    await expect(common.getByRole("button", { name: room })).toBeVisible()
  await common.scrollIntoViewIfNeeded()
  await shootBoth(page, "section-common-final")
})
