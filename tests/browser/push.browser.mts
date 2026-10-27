// Reminders end to end in Chromium, short of a push service: a trip planned on the map, leaving now or to be there
// by a time, or walked the whole way, "Remind me" asking a stubbed Worker to watch the first bus, or just the leave
// time, and nothing more, then a push delivered straight to the service worker through DevTools
// (ServiceWorker.deliverPushMessage), which shows the notification the phone words, and a tap on it, which opens
// the trip again and plans it afresh. Headless Chromium has no push service to subscribe with, so the subscription
// is a stub too, and shows no notifications, so they're recorded as the service worker shows them. WebKit can't be
// sent a push, so tests/shell/push.test.mts covers its handlers

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"
import { WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import type { Kept } from "../../src/reminders/reminder.mts"
import { type FeedData, arrivalTime, isServiceActive, serviceDayStart } from "../../src/transit/feed.mts"
import { buildOf } from "../../src/shell/manifest.mts"
import { addDays, clockOf, hhmm } from "../../src/shared/time.mts"
import { distance } from "../../src/geo/projection.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// Every other origin, like Umo and the map's tiles, is out of reach, and only Chromium can be sent a push
test.use({ proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })
test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium can be sent a push through DevTools")

/**
 * A ride the built site's own timetable offers, whichever data the build has, real or the fixtures' few routes: the
 * trip of the timetable's first service day going farthest, from its first stop to the stop farthest from it, which a bus
 * beats walking to, its next stop, which is walked to, a time a quarter hour before it leaves, and when it gets
 * there
 */
const feedOf = (dist: string): FeedData =>
  JSON.parse(readFileSync(join(dist, buildOf(readFileSync(join(dist, "map/index.html"), "utf8")).data.gtfs), "utf8"))

const rideOf = (dist: string) => {
  const feed = feedOf(dist)
  for (let day = feed.start; day <= feed.end; day = addDays(day, 1)) {
    const rides = feed.trips
      .filter(trip => isServiceActive(feed.services[trip.service], day))
      .sort((a, b) => a.times[0] - b.times[0])
      .map(trip => {
        const from = feed.stops[trip.stops[0]]
        const farthest = trip.stops.reduce((farthest, stop, position) => distance(from, feed.stops[stop]) > distance(from, feed.stops[trip.stops[farthest]]) ? position : farthest, 0)
        return { trip, from, farthest, meters: distance(from, feed.stops[trip.stops[farthest]]) }
      })
    if (rides.length === 0)
      continue
    // The ride going farthest, the earliest of those, so a bus beats walking there however few routes the build has
    const { trip, from, farthest } = rides.reduce((best, ride) => ride.meters > best.meters ? ride : best)
    const base = serviceDayStart(day)
    return { from: from.name, near: feed.stops[trip.stops[1]].name, to: feed.stops[trip.stops[farthest]].name, at: new Date(base + (trip.times[0] - 900) * 1000), arrives: base + arrivalTime(trip, farthest) * 1000 }
  }
  throw new Error("The timetable has no service")
}

/**
 * A way the built site's timetable runs often: of the first service day's trips, those of the route and first stop
 * with the most, from that stop to the farthest along them, ten minutes before the hour they leave most in begins
 */
const oftenOf = (dist: string) => {
  const feed = feedOf(dist)
  let day = feed.start
  while (!feed.trips.some(trip => isServiceActive(feed.services[trip.service], day)))
    day = addDays(day, 1)
  const trips = Object.values(Object.groupBy(feed.trips.filter(trip => isServiceActive(feed.services[trip.service], day)), trip => `${trip.route} ${trip.stops[0]}`))
    .reduce((most, trips) => trips!.length > most!.length ? trips : most)!
  const times = trips.map(trip => trip.times[0]).sort((a, b) => a - b)
  const busiest = times.reduce((best, time) => times.filter(other => other >= time && other < time + 3600).length > times.filter(other => other >= best && other < best + 3600).length ? time : best)
  const [trip] = trips
  const from = feed.stops[trip.stops[0]]
  const farthest = trip.stops.reduce((farthest, stop) => distance(from, feed.stops[stop]) > distance(from, feed.stops[farthest]) ? stop : farthest)
  return { from: from.name, to: feed.stops[farthest].name, at: new Date(serviceDayStart(day) + (busiest - 600) * 1000) }
}

const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"

type Sent = { url: string, body: { device: string, watch: Record<string, unknown> }, secret?: string }

/** The page on the map at a fixed time, with the Worker stubbed and what it's asked recorded, and the service worker's notifications recorded as shown */
const setUp = async (page: Page, context: BrowserContext, fixture: Fixture, at: Date) => {
  await page.clock.setFixedTime(at)
  // Headless Chromium has no push service to subscribe with and denies notifications whatever's granted, which a map
  // that loads would take as pushes no longer reaching it
  await context.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "granted" })
    const subscription = {
      toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/stub", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6", auth: "BTBZMqHH6r4Tts7J_aSIgg" } })
    } as unknown as PushSubscription
    PushManager.prototype.subscribe = async () => subscription
    PushManager.prototype.getSubscription = async () => subscription
  })
  const sent: Sent[] = []
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

  const kept = async () => ((await page.evaluate(async () => (await (await caches.open("reminders-v1")).match("/reminders.json"))!.json())) as { reminders: Kept[] }).reminders
  /** Records the notifications the service worker shows, as headless Chromium shows none */
  const record = async () => {
    const [worker] = context.serviceWorkers()
    await worker.evaluate(() => {
      type Shown = { title: string, body?: string, tag?: string }
      const scope = self as unknown as { shown: Shown[], registration: { showNotification(title: string, options?: Omit<Shown, "title">): Promise<void> } }
      scope.shown = []
      scope.registration.showNotification = async (title, options = {}) => void scope.shown.push({ title, ...options })
    })
    return () => worker.evaluate(() => (self as unknown as { shown: { title: string, body: string, tag: string }[] }).shown)
  }
  const push = async (data: string) =>
    cdp.send("ServiceWorker.deliverPushMessage", { origin: fixture.origin, registrationId: await registration, data })
  const plan = async (from: string, to: string) => {
    // From the home, directions is its button; from directions, as after Back, it's already there
    if (!await page.getByPlaceholder("Where to?").isVisible())
      await page.getByRole("button", { name: "Directions", exact: true }).click()
    for (const [field, place] of [["Search or tap the map", from], ["Where to?", to]]) {
      await page.getByPlaceholder(field).click()
      await page.getByPlaceholder(field).fill(place)
      await page.keyboard.press("Enter")
    }
  }
  const puts = () => sent.filter(({ body }) => body?.watch)
  return { sent, puts, kept, record, push, plan }
}

const idOf = ({ url }: Sent) =>
  decodeURIComponent(new URL(url).pathname.split("/").at(-1)!.split("?")[0])

test("a reminder set from an itinerary asks the Worker only to watch the first bus, a tap on its notification opens the trip again without a watch to replace, its push shows when to leave, and once told or past it's not planned again", async ({ page, context, fixture }) => {
  // Four loads of the map, each planning the trip again, with the waits between
  test.slow()
  const ride = rideOf(process.env.NOTUNH_DIST!)
  const { sent, puts, kept, record, push, plan } = await setUp(page, context, fixture, ride.at)
  await plan(ride.from, ride.to)
  await page.locator(".itinerary-summary").first().click()
  await page.getByRole("combobox", { name: "Heads-up before leaving" }).selectOption("300")
  await page.getByRole("button", { name: "Remind me" }).click()
  await expect(page.getByText("Reminder set")).toBeVisible()

  // The Worker hears of the first bus's run, its scheduled time, and the lead: nothing of where the trip goes, which
  // the phone keeps whole
  expect(puts()).toHaveLength(1)
  const { watch } = puts()[0].body
  expect(Object.keys(watch).sort()).toEqual(["at", "lead", "run"])
  expect(Object.keys(watch.run as object).sort()).toEqual(["route", "stop", "trip"])
  expect(Object.keys(puts()[0].body).sort()).toEqual(["device", "subscription", "watch"])
  expect(puts()[0].secret).toMatch(/^Bearer /)
  expect(JSON.stringify(puts()[0].body)).not.toContain(ride.to)
  const id = idOf(puts()[0])
  const [reminder] = await kept()
  const first = reminder.legs.find(leg => leg.kind === "ride")!
  expect(reminder).toMatchObject({ id, to: { name: ride.to }, headsUp: 300, state: "set" })
  expect(first).toMatchObject({ trip: (watch.run as { trip: string }).trip, scheduled: watch.at })
  // The walk to the stop, the heads-up, and a minute more as no bus is out, to the half minute
  const [walk] = reminder.legs
  expect(walk.kind).toBe("walk")
  expect(watch.lead).toBe(Math.ceil(((walk as { walk: number }).walk + 300 + 60) / 30) * 30)

  // Tapped a couple of minutes on, as a notification is, the map opens on the trip, plans it again once the live
  // buses have been asked for, and finds the same bus, so the Worker isn't told again
  await page.clock.setFixedTime(ride.at.getTime() + 2 * 60_000)
  await page.goto(`${fixture.origin}/map/?reminder=${encodeURIComponent(id)}`)
  await expect(page.getByPlaceholder("Where to?")).toHaveValue(ride.to)
  await expect(page).toHaveURL(`${fixture.origin}/map/?directions`)
  await expect(page.getByText("Reminder set")).toBeVisible()
  await page.waitForTimeout(2000)
  expect(puts()).toHaveLength(1)

  // The Worker wakes the phone with what it foretells of the bus, and the service worker words it from the reminder it
  // keeps, where it goes included
  const shown = await record()
  await push(pushOf({ v: WAKE_VERSION, reminder: id, kind: "due", seen: { time: first.expected + 120, band: 90, isLive: true, status: "coming" }, at: first.expected - 900 }))
  await expect.poll(shown).toHaveLength(1)
  const [notification] = await shown()
  expect(notification.title).toMatch(/^Leave (now|in \d+ min)$/)
  expect(notification.body).toContain("(2 min late)")
  expect(notification.body).toContain(ride.to)
  expect(notification).toMatchObject({ tag: `reminder-${id}` })

  // Opened two hours on, for the way back, the trip is past and the phone was told of it, so it isn't planned again
  // as a later bus's: the Worker hears nothing, and the reminder is kept as it was
  await page.clock.setFixedTime(ride.at.getTime() + 2 * 3600_000)
  await page.goto(`${fixture.origin}/map/`)
  await expect(page.getByPlaceholder("Where to?")).toHaveValue(ride.to)
  await page.waitForTimeout(2000)
  expect(puts()).toHaveLength(1)
  const [told] = await kept()
  expect(told).toMatchObject({ id, start: reminder.start, last: { kind: "due" } })
  expect(told.legs).toEqual(reminder.legs)

  // Back at the trip's time, the reminder shows on its way, told, so again not planned anew
  await page.clock.setFixedTime(ride.at.getTime() + 2 * 60_000)
  await page.reload()
  await expect(page.getByText("Reminder set")).toBeVisible()
  await page.waitForTimeout(2000)
  expect(puts()).toHaveLength(1)

  // Cancelling it tells the Worker, by the device's secret, and the phone keeps nothing of it once the Worker's heard
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByRole("button", { name: "Remind me" })).toBeVisible()
  await expect.poll(() => sent.filter(({ body }) => !body?.watch).length).toBe(1)
  expect(sent.at(-1)).toMatchObject({ url: `${puts()[0].url}?device=${encodeURIComponent(puts()[0].body.device)}`, secret: puts()[0].secret })
  await expect.poll(kept).toEqual([])
})

test("a later departure of the same way, tapped under its card, is the one chosen and the one reminded of", async ({ page, context, fixture }) => {
  const ride = oftenOf(process.env.NOTUNH_DIST!)
  const { puts, kept, plan } = await setUp(page, context, fixture, ride.at)
  await plan(ride.from, ride.to)
  const card = page.locator(".itinerary").filter({ has: page.getByRole("group", { name: "Other departures" }) }).first()
  const later = card.getByRole("group", { name: "Other departures" }).getByRole("button").last()
  const leave = (await later.getAttribute("aria-label"))!.replace("Leave at ", "")
  await later.click()

  // The card shows it, chosen and open, focus on it, and its best departure is now the other one offered
  const summary = card.locator(".itinerary-summary")
  await expect(card).toHaveClass(/selected/)
  await expect(summary).toHaveAttribute("aria-expanded", "true")
  await expect(summary).toBeFocused()
  await expect(card.getByRole("button", { name: `Leave at ${leave}`, exact: true })).toHaveCount(0)

  await card.getByRole("button", { name: "Remind me" }).click()
  await expect(card.getByText("Reminder set")).toBeVisible()
  expect(puts()).toHaveLength(1)
  const [reminder] = await kept()
  expect(clockOf(reminder.start * 1000)).toBe(leave)
})

test("a trip to be there by a time leaves as late as makes it, its reminder keeps the time, and the goal can be saved and opened again", async ({ page, context, fixture }) => {
  const ride = rideOf(process.env.NOTUNH_DIST!)
  const { puts, kept, plan } = await setUp(page, context, fixture, ride.at)
  await plan(ride.from, ride.to)
  const leaveNow = page.locator(".leave").first()
  await expect(leaveNow).toHaveText(/^Leave (now|in \d+ min|at .+)$/)
  await page.getByRole("button", { name: "Arrive by" }).click()
  const by = hhmm(ride.arrives + 15 * 60_000)
  await page.getByLabel("Arrive by").fill(by)
  await page.getByLabel("Arrive by").dispatchEvent("change")
  await expect(page.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "true")
  await expect(leaveNow).toHaveText(/^Leave at .+ · arrives .+$/)
  await page.locator(".itinerary-summary").first().click()
  await page.getByRole("button", { name: "Remind me" }).click()
  await expect(page.getByText("Reminder set")).toBeVisible()
  expect(puts()).toHaveLength(1)
  expect(Object.keys(puts()[0].body.watch).sort()).toEqual(["at", "lead", "run"])
  const [reminder] = await kept()
  expect(reminder.by).toBeDefined()
  expect(hhmm(reminder.by! * 1000)).toBe(by)
  expect(reminder.end).toBeLessThanOrEqual(reminder.by!)
  expect(reminder.margin).toBeLessThanOrEqual(reminder.by! - reminder.end)

  // Saved as a goal, a row of Yours on the home, which opens the same trip by the same time
  await page.getByRole("button", { name: "Save trip", exact: true }).click()
  await expect(page.getByRole("button", { name: "Save trip", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Back to Map" }).click()
  const goal = page.getByRole("list", { name: "Yours" }).getByRole("button", { name: ride.to }).filter({ hasText: "Saved trip" })
  await expect(goal).toBeVisible()
  await goal.click()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue(ride.to)
  await expect(page.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByLabel("Arrive by")).toHaveValue(by)
  await expect(goal).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem("map-goals"))).toContain(`"by":"${by}"`)
})

test("a reminder set is a row of Yours on the home, where a tap opens its trip again and × cancels it, while saving a trip sets no reminder", async ({ page, context, fixture }) => {
  const ride = rideOf(process.env.NOTUNH_DIST!)
  const { sent, puts, kept, plan } = await setUp(page, context, fixture, ride.at)
  const yours = page.getByRole("list", { name: "Yours" })
  const listed = yours.getByRole("button", { name: ride.to }).filter({ hasText: "Reminder" })
  const back = () => page.getByRole("button", { name: "Back to Map" }).click()
  await plan(ride.from, ride.to)
  await expect(listed).toHaveCount(0)
  await page.locator(".itinerary-summary").first().click()
  await page.getByRole("button", { name: "Remind me" }).click()
  await expect(page.getByText("Reminder set")).toBeVisible()
  expect(puts()).toHaveLength(1)

  // Listed on the home, where opening it brings the trip back, its reminder shown set
  await back()
  await expect(page.getByPlaceholder("Where to?")).toBeHidden()
  await expect(listed).toBeVisible()
  await listed.click()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue(ride.to)
  await expect(page.getByText("Reminder set")).toBeVisible()

  // Cancelled from the list, it's gone from it and from the trip, and the Worker is told
  await back()
  await yours.getByRole("button", { name: `Cancel reminder for ${ride.to}` }).click()
  await expect(listed).toHaveCount(0)
  await expect.poll(() => sent.filter(({ body }) => !body?.watch).length).toBe(1)
  await expect.poll(kept).toEqual([])

  // Saving a trip sets no reminder: a row of Yours, no reminder kept, and no watch for the Worker
  await plan(ride.from, ride.to)
  await page.getByRole("button", { name: "Arrive by" }).click()
  await page.getByLabel("Arrive by").fill(hhmm(ride.arrives + 15 * 60_000))
  await page.getByLabel("Arrive by").dispatchEvent("change")
  await page.getByRole("button", { name: "Save trip", exact: true }).click()
  await back()
  await expect(yours.getByRole("button", { name: ride.to }).filter({ hasText: "Saved trip" })).toBeVisible()
  await expect(listed).toHaveCount(0)
  expect(await kept()).toEqual([])
  expect(puts()).toHaveLength(1)
})

test("walking the whole way can be reminded of too, which the Worker watches as a time alone, and whose push names the walk", async ({ page, context, fixture }) => {
  const ride = rideOf(process.env.NOTUNH_DIST!)
  const { puts, kept, record, push, plan } = await setUp(page, context, fixture, ride.at)
  await plan(ride.from, ride.near)
  await page.getByRole("button", { name: "Arrive by" }).click()
  const by = hhmm(ride.arrives + 30 * 60_000)
  await page.getByLabel("Arrive by").fill(by)
  await page.getByLabel("Arrive by").dispatchEvent("change")
  await page.locator(".walk-option").click()
  await expect(page.locator(".walk-option")).toHaveText(/leave/)
  await page.getByRole("button", { name: "Remind me" }).click()
  await expect(page.getByText("Reminder set")).toBeVisible()
  expect(puts()).toHaveLength(1)
  const { watch } = puts()[0].body
  expect(Object.keys(watch).sort()).toEqual(["at", "lead"])
  expect(watch.lead).toBe(300)
  const id = idOf(puts()[0])
  const [reminder] = await kept()
  expect(reminder.legs.map(leg => leg.kind)).toEqual(["walk"])
  expect(reminder.start).toBe(watch.at)
  expect(reminder.end).toBeLessThanOrEqual(reminder.by!)

  const shown = await record()
  await push(pushOf({ v: WAKE_VERSION, reminder: id, kind: "due", seen: { time: reminder.start, band: 0, isLive: false, status: "coming" }, at: reminder.start - 300 }))
  await expect.poll(shown).toHaveLength(1)
  const [notification] = await shown()
  expect(notification.title).toMatch(/^Leave (now|in \d+ min)$/)
  expect(notification.body).toMatch(new RegExp(`^\\d+ min walk to ${RegExp.escape(ride.near)}, there .+, before your .+\\.$`))
})
