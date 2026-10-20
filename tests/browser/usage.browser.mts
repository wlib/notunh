// Usage stats as a first visit sees them: the question, the home page's setting, and what's sent PostHog, which a
// stub in the browser answers, and which never gets past the browser to PostHog itself

import { gunzipSync } from "node:zlib"
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"

const POSTHOG = /^https:\/\/[\w.-]*posthog\.com\//

type Event = { uuid: string, event: string, properties: Record<string, unknown> }

const test = base.extend<{ fixture: Fixture, usageOrigin: Fixture, posthog: Event[] }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  },
  usageOrigin: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!, { isUsageOrigin: true })
    await use(fixture)
    await fixture.close()
  },
  // Every event the pages send PostHog, whichever way posthog-js encodes them. The stub answers what it can, but
  // WebKit hands it nothing a service worker could have answered, so that goes to a proxy that isn't there
  posthog: async ({ context }, use) => {
    const events: Event[] = []
    // posthog-js sends nothing for a browser it takes for a bot, as one driven by automation or headless is
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false })
      Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined })
    })
    await context.route(POSTHOG, route => route.fulfill({ json: { status: 1 } }))
    context.on("request", request => {
      const body = request.postDataBuffer()
      if (!POSTHOG.test(request.url()) || !body?.length)
        return
      const text = body[0] === 0x1f ? gunzipSync(body).toString()
        : /^data=/.test(body.toString()) ? Buffer.from(decodeURIComponent(body.toString().slice(5)), "base64").toString()
        : body.toString()
      const sent: Event[] = [JSON.parse(text)].flatMap(sent => sent.batch ?? sent)
      // Once each, as one that didn't get through is sent again
      events.push(...sent.filter(({ uuid }) => !events.some(event => event.uuid === uuid)))
    })
    await use(events)
  }
})

// Every other origin is out of reach
test.use({ proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })

/** Every event of a name sent PostHog, waiting for the first */
const sent = async (events: Event[], name: string) => {
  await expect.poll(() => events.some(({ event }) => event === name), { timeout: 15_000 }).toBe(true)
  return events.filter(({ event }) => event === name)
}

/** What the page keeps of PostHog's on the device: its cookies and its localStorage keys */
const kept = async (context: BrowserContext, page: Page) => ({
  cookies: await context.cookies(),
  storage: await page.evaluate(() => Object.keys(localStorage).filter(key => /^(ph_|__ph)/.test(key)))
})

test("a first visit is asked once, the answer is the home page's setting, and nothing reaches PostHog off notunh.app", async ({ page, fixture, posthog }) => {
  await page.goto(`${fixture.origin}/dining/`)
  await page.getByRole("button", { name: "Ok", exact: true }).click()
  await expect(page.locator(".usage-prompt")).toHaveCount(0)

  await page.goto(`${fixture.origin}/#usage`)
  await expect(page.locator(".usage-prompt")).toHaveCount(0)
  await expect(page.getByLabel("Share usage stats")).toBeChecked()
  await page.getByLabel("Share usage stats").uncheck()
  await page.reload()
  await expect(page.getByLabel("Share usage stats")).not.toBeChecked()
  await expect(page.locator(".usage-prompt")).toHaveCount(0)
  await page.waitForTimeout(1000)
  expect(posthog).toEqual([])
})

test("a browser with Global Privacy Control isn't asked, and its setting says why", async ({ page, fixture }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "globalPrivacyControl", { value: true }))
  await page.goto(`${fixture.origin}/#usage`)
  await expect(page.locator(".usage-prompt")).toHaveCount(0)
  await expect(page.getByLabel("Share usage stats")).toBeDisabled()
  await expect(page.getByText("Global Privacy Control")).toBeVisible()
})

test("on notunh.app, page views are counted keeping nothing until a yes, which remembers the device and counts features, and a no forgets it", async ({ context, page, usageOrigin, posthog }) => {
  await page.goto(`${usageOrigin.origin}/laundry/`)
  const [view] = await sent(posthog, "$pageview")
  expect(view.properties.$current_url).toBe(`${usageOrigin.origin}/laundry/`)
  expect(view.properties.$geoip_disable).toBe(true)
  expect(await kept(context, page)).toEqual({ cookies: [], storage: [] })

  await page.getByRole("button", { name: "Ok", exact: true }).click()
  await page.locator(".room-open").first().click()
  const [opened] = await sent(posthog, "laundry_room_opened")
  expect(Object.keys(opened.properties)).not.toContain("room")
  // A room's own address is counted as every room's
  for (const { properties } of posthog)
    expect(String(properties.$current_url)).not.toMatch(/\/laundry\/(?!room\/)[^/]+\//)
  const remembered = await kept(context, page)
  expect(remembered.cookies).toEqual([])
  expect(remembered.storage.length).toBeGreaterThan(0)

  await page.goto(`${usageOrigin.origin}/#usage`)
  await page.getByLabel("Share usage stats").uncheck()
  await expect.poll(async () => (await kept(context, page)).storage).toEqual([])
  expect(await kept(context, page)).toEqual({ cookies: [], storage: [] })
})

test("on notunh.app, PostHog's code is kept with the page, so a page opened offline still counts its errors", async ({ page, usageOrigin, posthog }) => {
  await page.goto(`${usageOrigin.origin}/dining/`)
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await sent(posthog, "$pageview")
  await expect.poll(() => page.evaluate(async () => (await (await caches.open("app-v2")).keys()).some(({ url }) => /posthog/.test(url))), { timeout: 15_000 }).toBe(true)

  // The site offline, as on a phone with no signal, where PostHog's code comes from the cache
  await usageOrigin.setOffline(true)
  await page.reload()
  await expect.poll(() => posthog.filter(({ event }) => event === "$pageview").length, { timeout: 15_000 }).toBe(2)
  await page.evaluate(() => setTimeout(() => { throw new Error("Something broke offline") }))
  const [error] = await sent(posthog, "$exception")
  expect(JSON.stringify(error.properties)).toContain("Something broke offline")
})

test("on notunh.app, a trip planned after a yes is counted by its ends' places and the hour, linked to nothing", async ({ page, usageOrigin, posthog }) => {
  await page.goto(`${usageOrigin.origin}/map/`)
  await page.getByRole("button", { name: "Ok", exact: true }).click()
  for (const [field, place] of [["Search or tap the map", "Holloway"], ["Where to?", "Kingsbury"]]) {
    await page.getByPlaceholder(field).click()
    await page.getByPlaceholder(field).fill(place)
    await page.keyboard.press("Enter")
  }
  const [trip] = await sent(posthog, "trip_planned")
  expect(trip.properties).toMatchObject({ from: expect.stringContaining("Holloway"), to: expect.stringContaining("Kingsbury"), walk_only: expect.any(Boolean) })
  expect(trip.properties.hour_of_week).toBeGreaterThanOrEqual(0)
  // Nothing it shares with the device's other events
  const others = posthog.filter(event => event !== trip)
  expect(others.length).toBeGreaterThan(0)
  for (const key of ["distinct_id", "$session_id", "$device_id", "$window_id"])
    expect(others.map(({ properties }) => properties[key])).not.toContain(trip.properties[key] ?? "none")
  expect(Object.keys(trip.properties).sort()).toEqual(["$geoip_disable", "$process_person_profile", "distinct_id", "from", "hour_of_week", "itineraries", "rides_bus", "to", "token", "walk_only"])
})
