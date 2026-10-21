// A reminder end to end in Chromium, short of a push service: a trip planned on the map, "Remind me when to leave"
// asking a stubbed Worker to watch the run and nothing more, then a push delivered straight to the service worker
// through DevTools (ServiceWorker.deliverPushMessage), which shows the notification the phone words. Headless
// Chromium has no push service to subscribe with, so the subscription is a stub too, and shows no notifications, so
// they're recorded as the service worker shows them. WebKit can't be sent a push, so
// tests/shell/push.test.mts covers its handlers

import { test as base, expect } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"
import { pushOf } from "../../src/reminders/watch.mts"
import type { Reminder } from "../../src/reminders/reminder.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// A Wednesday at noon in Durham, with buses running, and every other origin, like Umo and the map's tiles, out of reach
const NOON = new Date("2026-10-07T16:00:00Z")
test.use({ proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })

const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"

test("a reminder set from an itinerary asks the Worker only to watch the run, and its push shows when to leave", async ({ page, context, fixture, browserName }) => {
  test.skip(browserName !== "chromium", "Only Chromium can be sent a push through DevTools")
  await page.clock.setFixedTime(NOON)
  await context.addInitScript(() => {
    PushManager.prototype.subscribe = async () => ({
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/stub", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6", auth: "BTBZMqHH6r4Tts7J_aSIgg" } })
    }) as unknown as PushSubscription
  })
  const sent: { url: string, body: { watch: Record<string, unknown> }, secret?: string }[] = []
  await context.route("**/api/push/key", route => route.fulfill({ json: { key: KEY } }))
  await context.route("**/api/reminders/**", async route => {
    sent.push({ url: route.request().url(), body: route.request().postDataJSON(), secret: route.request().headers().authorization })
    await route.fulfill({ status: 204 })
  })

  const cdp = await context.newCDPSession(page)
  await cdp.send("ServiceWorker.enable")
  const registration = new Promise<string>(resolve =>
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const ours = registrations.find(({ scopeURL, isDeleted }) => scopeURL.startsWith(fixture.origin) && !isDeleted)
      if (ours)
        resolve(ours.registrationId)
    })
  )

  await page.goto(`${fixture.origin}/map/`)
  await page.getByRole("button", { name: "No", exact: true }).click()
  for (const [field, place] of [["Search or tap the map", "Dover Transportation Center"], ["Where to?", "Kingsbury Hall"]]) {
    await page.getByPlaceholder(field).click()
    await page.getByPlaceholder(field).fill(place)
    await page.keyboard.press("Enter")
  }
  await page.locator(".itinerary-summary").first().click()
  await page.getByRole("combobox", { name: "When to remind you" }).selectOption("10")
  await page.getByRole("button", { name: "Remind me when to leave" }).click()
  await expect(page.getByText("Reminder set")).toBeVisible()

  // The Worker hears of the run, the stop, and the lead chosen: nothing of where the trip goes, which the phone keeps
  // whole
  expect(sent).toHaveLength(1)
  const { watch } = sent[0].body
  expect(Object.keys(watch).sort()).toEqual(["lead", "route", "scheduled", "stop", "trip"])
  expect(watch.lead).toBe(600)
  expect(Object.keys(sent[0].body).sort()).toEqual(["device", "subscription", "watch"])
  expect(sent[0].secret).toMatch(/^Bearer /)
  expect(JSON.stringify(sent[0].body)).not.toContain("Kingsbury")
  const id = decodeURIComponent(new URL(sent[0].url).pathname.split("/").at(-1)!)
  const reminder = await page.evaluate(() => new Promise<Reminder>(resolve => {
    const open = indexedDB.open("notunh-reminders")
    open.onsuccess = () => {
      const all = open.result.transaction("reminders").objectStore("reminders").getAll()
      all.onsuccess = () => resolve(all.result[0])
    }
  }))
  expect(reminder).toMatchObject({ id, stop: watch.stop, route: watch.route, trip: watch.trip, scheduled: watch.scheduled, lead: 600, to: "Kingsbury Hall" })

  // Headless Chromium shows no notifications, so the service worker's are recorded as it shows them
  const [worker] = context.serviceWorkers()
  await worker.evaluate(() => {
    type Shown = { title: string, body?: string, tag?: string }
    const scope = self as unknown as { shown: Shown[], registration: { showNotification(title: string, options?: Omit<Shown, "title">): Promise<void> } }
    scope.shown = []
    scope.registration.showNotification = async (title, options = {}) => void scope.shown.push({ title, ...options })
  })

  // The Worker wakes the phone with what it foretells of the run, and the service worker words it from the reminder
  // it keeps, where it goes included
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin:         fixture.origin,
    registrationId: await registration,
    data:           pushOf({ reminder: id, kind: "due", seen: { time: reminder.expected + 120, band: 90, isLive: true, status: "coming" }, at: reminder.expected - 900 })
  })
  const shown = () => worker.evaluate(() => (self as unknown as { shown: { title: string, body: string, tag: string }[] }).shown)
  await expect.poll(shown).toHaveLength(1)
  const [notification] = await shown()
  expect(notification.title).toMatch(/^Leave (now|in \d+ min)$/)
  expect(notification.body).toContain("(2 min late)")
  expect(notification.body).toContain("Kingsbury")
  expect(notification).toMatchObject({ tag: `reminder-${id}` })

  // Cancelling it tells the Worker, by the device's secret
  await page.getByRole("button", { name: "Cancel reminder" }).click()
  await expect(page.getByRole("button", { name: "Remind me when to leave" })).toBeVisible()
  expect(sent).toHaveLength(2)
})
