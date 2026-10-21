// A reminder end to end in Chromium, short of a push service: a trip planned on the map, "Remind me when to leave"
// asking a stubbed Worker to watch the run and nothing more, then a push delivered straight to the service worker
// through DevTools (ServiceWorker.deliverPushMessage), which shows the notification the phone words. Headless
// Chromium has no push service to subscribe with, so the subscription is a stub too, and shows no notifications, so
// they're recorded as the service worker shows them. WebKit can't be sent a push, so tests/shell/push.test.mts
// covers its handlers

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"
import { WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import type { Kept } from "../../src/reminders/reminder.mts"
import { type FeedData, isServiceActive, serviceDayStart } from "../../src/transit/feed.mts"
import { buildOf } from "../../src/shell/manifest.mts"
import { addDays } from "../../src/shared/time.mts"
import { distance } from "../../src/geo/projection.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// Every other origin, like Umo and the map's tiles, is out of reach
test.use({ proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })

/**
 * A ride the built site's own timetable offers, whichever data the build has, real or the fixtures' few routes: the
 * first trip of the timetable's first service day, from its first stop to the stop farthest from it, which a bus
 * beats walking to, and a time shortly before it leaves
 */
const rideOf = (dist: string) => {
  const { data } = buildOf(readFileSync(join(dist, "map/index.html"), "utf8"))
  const feed: FeedData = JSON.parse(readFileSync(join(dist, data.gtfs), "utf8"))
  for (let day = feed.start; day <= feed.end; day = addDays(day, 1)) {
    const [trip] = feed.trips.filter(trip => isServiceActive(feed.services[trip.service], day)).sort((a, b) => a.times[0] - b.times[0])
    if (!trip)
      continue
    const from = feed.stops[trip.stops[0]]
    const to = trip.stops.map(stop => feed.stops[stop]).reduce((farthest, stop) => distance(from, stop) > distance(from, farthest) ? stop : farthest)
    return { from: from.name, to: to.name, at: new Date(serviceDayStart(day) + (trip.times[0] - 600) * 1000) }
  }
  throw new Error("The timetable has no service")
}

const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"

test("a reminder set from an itinerary asks the Worker only to watch the run, and its push shows when to leave", async ({ page, context, fixture, browserName }) => {
  test.skip(browserName !== "chromium", "Only Chromium can be sent a push through DevTools")
  const ride = rideOf(process.env.NOTUNH_DIST!)
  await page.clock.setFixedTime(ride.at)
  await context.addInitScript(() => {
    PushManager.prototype.subscribe = async () => ({
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/stub", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6", auth: "BTBZMqHH6r4Tts7J_aSIgg" } })
    }) as unknown as PushSubscription
  })
  const sent: { url: string, body: { device: string, watch: Record<string, unknown> }, secret?: string }[] = []
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
  for (const [field, place] of [["Search or tap the map", ride.from], ["Where to?", ride.to]]) {
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
  expect(JSON.stringify(sent[0].body)).not.toContain(ride.to)
  const id = decodeURIComponent(new URL(sent[0].url).pathname.split("/").at(-1)!)
  const kept = async () => (await page.evaluate(async () => (await (await caches.open("reminders-v1")).match("/reminders.json"))!.json())) as { reminders: Kept[] }
  const [reminder] = (await kept()).reminders
  expect(reminder).toMatchObject({ id, stop: watch.stop, route: watch.route, trip: watch.trip, scheduled: watch.scheduled, lead: 600, to: ride.to, state: "set" })

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
    data:           pushOf({ v: WAKE_VERSION, reminder: id, kind: "due", seen: { time: reminder.expected + 120, band: 90, isLive: true, status: "coming" }, at: reminder.expected - 900 })
  })
  const shown = () => worker.evaluate(() => (self as unknown as { shown: { title: string, body: string, tag: string }[] }).shown)
  await expect.poll(shown).toHaveLength(1)
  const [notification] = await shown()
  expect(notification.title).toMatch(/^Leave (now|in \d+ min)$/)
  expect(notification.body).toContain("(2 min late)")
  expect(notification.body).toContain(ride.to)
  expect(notification).toMatchObject({ tag: `reminder-${id}` })

  // Cancelling it tells the Worker, by the device's secret, and the phone keeps nothing of it once the Worker's heard
  await page.getByRole("button", { name: "Cancel reminder" }).click()
  await expect(page.getByRole("button", { name: "Remind me when to leave" })).toBeVisible()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]).toMatchObject({ url: sent[0].url.replace(`/${encodeURIComponent(id)}`, `/${encodeURIComponent(id)}?device=${encodeURIComponent(sent[0].body.device)}`), secret: sent[0].secret })
  await expect.poll(async () => (await kept()).reminders).toEqual([])
})
