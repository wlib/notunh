// The social layer on a phone, against the Worker's app served from Node (tests/worker/serve.mts): today's list
// plans a trip by an event's start; an event made here opens for anyone and counts them going, of its spots;
// sharing makes a story image; an event of times to pick takes marks, its host sets one, and those who marked it
// are asked "Going?"; a code links two devices; and an emailed code verifies an address. Screenshots go to
// NOTUNH_SHOTS when it's set

import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect, devices, type Browser, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"
import { pinPath } from "../../src/social/event.mts"
import { atClock, hhmm, localDay } from "../../src/shared/time.mts"


/** The Worker's app, started once for every test this process runs of this file, for each browser in turn */
let worker: { origin: string, process: ChildProcess } | undefined

const startWorker = () =>
  new Promise<typeof worker>((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "../worker/serve.mts"), process.env.NOTUNH_DIST!], { stdio: ["ignore", "pipe", "inherit"] })
    child.stdout.on("data", (chunk: Buffer) => {
      const port = chunk.toString().match(/PORT (\d+)/)?.[1]
      if (port)
        resolve({ origin: `http://127.0.0.1:${port}`, process: child })
    })
    child.on("exit", code => reject(new Error(`The Worker exited with ${code}`)))
  })

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    worker ??= await startWorker()
    const fixture = await startFixture(process.env.NOTUNH_DIST!, { worker: worker!.origin })
    await use(fixture)
    await fixture.close()
  }
})

test.afterAll(() => {
  worker?.process.kill()
  worker = undefined
})

// A phone, with every other origin out of reach
const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York" })

const SHOTS = process.env.NOTUNH_SHOTS
if (SHOTS)
  mkdirSync(SHOTS, { recursive: true })

const shoot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: join(SHOTS, `${name}-${test.info().project.name}.png`) }) : Promise.resolve()

/** A page, with the usage question answered if it's asked, as it is once a browser */
const open = async (page: Page, origin: string, path: string) => {
  await page.goto(origin + path)
  const no = page.getByRole("button", { name: "No", exact: true })
  await no.waitFor({ timeout: 3000 }).then(() => no.click(), () => {})
}

const openMap = (page: Page, origin: string) =>
  open(page, origin, "/map/")

type Timed = { start: number, end: number, place?: string, source: string }

/**
 * The build's placed events, or others given, moved to today, each starting an hour after the last from a whole hour
 * ahead, so the list has them
 */
const eventsToday = (page: Page, base: number, given?: Timed[]) =>
  page.route(/\/assets\/events-[\w-]+\.json$/, async route => {
    const data = await (await route.fetch()).json() as { fetched: number, events: Timed[] }
    data.events = (given ?? data.events).filter(event => event.place).map((event, i) => ({ ...event, start: base + (i + 1) * 3_600_000, end: base + (i + 2) * 3_600_000 }))
    await route.fulfill({ json: data })
  })

/** Fills a day, a start and an end, the nth offered, with an hour from a moment */
const fillWhen = async (page: Page, n: number, at: number) => {
  await page.locator("input[name=day]").nth(n).fill(localDay(at))
  await page.locator("input[name=start]").nth(n).fill(hhmm(at))
  await page.locator("input[name=end]").nth(n).fill(hhmm(at + 3_600_000))
}

/**
 * Makes an event through the form, an hour and a half from now, and another time two hours later if asked, and lands
 * on its page on the map; gives the link anyone may open it at
 */
const makePin = async (page: Page, title: string, { place = "Thompson Hall", more = false, spots = "" } = {}) => {
  await page.getByRole("button", { name: "New event" }).click()
  await page.getByLabel("What").fill(title)
  await page.locator("input[name=place]").fill(place)
  await page.getByLabel("Where exactly").fill("by the steps")
  const at = Date.now() + 90 * 60_000
  await fillWhen(page, 0, at)
  if (more) {
    await page.getByRole("button", { name: "+ Another time" }).click()
    await fillWhen(page, 1, at + 2 * 3_600_000)
  }
  await page.getByLabel("Spots").fill(spots)
  await shoot(page, more ? "new-event-times" : "new-event")
  await page.getByRole("button", { name: "Post it" }).click()
  await expect(page).toHaveURL(/\/map\/\?event=[\w-]+$/)
  await expect(page.getByRole("heading", { name: title })).toBeVisible()
  return pinPath(new URL(page.url()).searchParams.get("event")!)
}

/** Another phone, with no history, as someone the link was sent to */
const stranger = (browser: Browser) =>
  browser.newContext({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" } })

test("today's list opens an event's page, whose Directions plans a trip to its place by its start", async ({ page, fixture }) => {
  // Mid-morning today, so the events after it are today's whatever the time this runs
  const base = atClock(localDay(Date.now()), "10:00")
  await page.clock.setFixedTime(base)
  await eventsToday(page, base)
  await openMap(page, fixture.origin)
  const rows = page.getByRole("list", { name: "Today" }).locator(".row")
  await expect(rows.first()).toBeVisible()
  await shoot(page, "today")
  await rows.nth(1).click()
  await expect(page).toHaveURL(/\/map\/\?event=/)
  await expect(page.locator(".back")).toHaveText(/Map/)
  await page.getByRole("button", { name: "Directions" }).click()
  await expect(page.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("input[type=time]")).toHaveValue(hhmm(base + 2 * 3_600_000))
  await expect(page.getByPlaceholder("Where to?")).not.toHaveValue("")
  await shoot(page, "planned-from-event")
  // Back from the trip is the event's page again
  await page.goBack()
  await expect(page.getByRole("button", { name: "Directions" })).toBeVisible()
})

test("today's list has sport clubs' home events, by club, at the fields the map knows", async ({ page, fixture }) => {
  // The fixtures' rather than the build's, which has whatever the calendars said the night it was made
  const { events } = JSON.parse(readFileSync(new URL("../fixtures/data/src/map/events.json", import.meta.url), "utf8")) as { events: Timed[] }
  // The lacrosse game, the fourth placed, on in this hour, so it's on today's list whatever the time of day
  await eventsToday(page, Math.floor(Date.now() / 3_600_000) * 3_600_000 - 4 * 3_600_000, events.filter(event => event.source === "dserec"))
  await openMap(page, fixture.origin)
  // Under way, so in Now, with the rest of the day under it
  const rows = page.getByRole("list", { name: /^(Now|Today)$/ }).locator(".row")
  const row = rows.filter({ hasText: "Women’s Lacrosse game: UNHWCL Play Day" })
  await expect(row).toBeVisible()
  await expect(row).toContainText("Bremner Field")
  await rows.last().scrollIntoViewIfNeeded()
  await shoot(page, "today-clubs")
})

test("an event made here opens for anyone with the link, who can say they're going, of its spots, and its page previews it", async ({ page, browser, fixture }) => {
  // Three pages over three devices, the host's the map, which Chromium draws in software
  test.slow()
  await openMap(page, fixture.origin)
  const path = await makePin(page, "Pickup tennis", { spots: "2" })
  await expect(page.getByText("2 spots")).toBeVisible()
  await expect(page.getByRole("button", { name: "Going · 0 of 2" })).toBeVisible()
  await shoot(page, "event-host")

  // Someone else, on another phone with no history, from the link alone
  const other = await stranger(browser)
  const guest = await other.newPage()
  await open(guest, fixture.origin, path)
  await expect(guest.getByRole("heading", { name: "Pickup tennis" })).toBeVisible()
  await expect(guest.getByText("Thompson Hall")).toBeVisible()
  await expect(guest.getByRole("button", { name: "Delete this event" })).toHaveCount(0)
  await guest.getByRole("button", { name: "Going · 0 of 2" }).click()
  await expect(guest.getByRole("button", { name: "Going · 1 of 2" })).toHaveAttribute("aria-pressed", "true")
  await shoot(guest, "event-guest")
  // The page the Worker serves carries the event for link previews
  const html = await (await fetch(fixture.origin + path)).text()
  expect(html).toContain("<title>Pickup tennis · notunh</title>")
  expect(html).toMatch(/<meta property="og:description" content="[^"]*Thompson Hall[^"]*1 going">/)
  // Directions is the event on the map, whose Directions plans the trip to it
  await guest.getByRole("link", { name: "Directions" }).click()
  await expect(guest).toHaveURL(/\/map\/\?event=/)
  await guest.getByRole("button", { name: "Directions" }).click()
  await expect(guest.getByPlaceholder("Where to?")).toHaveValue("Thompson Hall")
  await expect(guest.getByRole("button", { name: "Arrive by" })).toHaveAttribute("aria-pressed", "true")
  await other.close()

  // The host takes the last spot, after which it's full to anyone else
  await page.reload()
  await page.getByRole("button", { name: "Going · 1 of 2" }).click()
  await expect(page.getByRole("button", { name: "Going · 2 of 2" })).toBeVisible()
  const late = await stranger(browser)
  const third = await late.newPage()
  await open(third, fixture.origin, path)
  await expect(third.getByRole("button", { name: "Full" })).toBeDisabled()
  await late.close()

  page.on("dialog", dialog => dialog.accept())
  await page.getByRole("button", { name: "Delete this event" }).click()
  await expect(page.getByText("This event is gone.")).toBeVisible()
  expect((await fetch(fixture.origin + path)).status).toBe(404)
})

test("sharing makes a story image, 1080 by 1920, handed to the share sheet with the link copied", async ({ page, fixture }) => {
  await page.addInitScript(() => {
    const shared: { name: string, type: string, size: number, width?: number, height?: number }[] = []
    Object.assign(window, { shared })
    navigator.canShare = () => true
    navigator.share = async ({ files }: ShareData) => {
      for (const file of files ?? []) {
        const bitmap = await createImageBitmap(file)
        shared.push({ name: file.name, type: file.type, size: file.size, width: bitmap.width, height: bitmap.height })
      }
    }
  })
  // The map, then a 1080 by 1920 canvas, which Chromium draws in software
  test.slow()
  await openMap(page, fixture.origin)
  await makePin(page, "Study at the library", { place: "Dimond Library" })
  await page.getByRole("button", { name: "Share" }).click()
  await expect(page.getByText("Link copied. In Instagram, add a Link sticker and paste.")).toBeVisible({ timeout: 30_000 })
  const shared = await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared)
  expect(shared).toHaveLength(1)
  expect(shared[0]).toMatchObject({ type: "image/png", width: 1080, height: 1920 })
  expect((shared[0] as { size: number }).size).toBeGreaterThan(10_000)
  await shoot(page, "shared")
})

test("an event of two times takes marks with no Going, its host sets one, and whoever marked it is asked Going?, which a tap answers", async ({ page, browser, fixture }) => {
  // Three pages over three devices, the host's the map, which Chromium draws in software
  test.slow()
  await openMap(page, fixture.origin)
  const path = await makePin(page, "Board games", { more: true })
  await expect(page.getByText("Time to pick")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Set the time" })).toBeVisible()
  await expect(page.locator(".time")).toHaveCount(2)
  await expect(page.getByRole("button", { name: /^Going/ })).toHaveCount(0)

  // Two people mark the later time, and one of them the earlier too
  const [one, two] = await Promise.all([stranger(browser), stranger(browser)])
  const [marker, other] = await Promise.all([one.newPage(), two.newPage()])
  for (const [who, times] of [[marker, [1]], [other, [0, 1]]] as const) {
    await open(who, fixture.origin, path)
    await expect(who.getByRole("heading", { name: "Mark the times that work" })).toBeVisible()
    await expect(who.getByRole("button", { name: /^Going/ })).toHaveCount(0)
    await expect(who.getByRole("button", { name: "Set" })).toHaveCount(0)
    for (const time of times) {
      await who.locator(".time").nth(time).getByRole("button", { name: "Mark" }).click()
      await expect(who.locator(".time").nth(time).getByRole("button", { name: "Works for me" })).toHaveAttribute("aria-pressed", "true")
    }
  }
  await expect(other.locator(".time").nth(1)).toContainText("2 can make it")
  // Unmarking takes one away, and marking again puts it back, once
  await other.locator(".time").nth(0).getByRole("button", { name: "Works for me" }).click()
  await expect(other.locator(".time").nth(0)).toContainText("0 can make it")
  await shoot(other, "marks")

  // The host sets the later time, which makes it an ordinary event that nobody is going to yet
  await page.reload()
  await expect(page.locator(".time").nth(1)).toContainText("2 can make it")
  await page.locator(".time").nth(1).getByRole("button", { name: "Set" }).click()
  await expect(page.getByText("Time to pick")).toHaveCount(0)
  await expect(page.locator(".time")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Going · 0" })).toBeVisible()
  await shoot(page, "set")

  // One who marked it is asked on the page; tapping the push's link answers Going for the other
  await marker.reload()
  await expect(marker.getByText(/^Set for \w{3} \d{1,2}:\d\d\s[AP]M · Going\?$/)).toBeVisible()
  await shoot(marker, "asked")
  await marker.getByRole("button", { name: "Going · 0" }).click()
  await expect(marker.getByRole("button", { name: "Going · 1" })).toHaveAttribute("aria-pressed", "true")
  await expect(marker.getByText(/Going\?$/)).toHaveCount(0)
  await other.goto("about:blank")
  await other.goto(`${fixture.origin}${path}#going`)
  await expect(other.getByRole("button", { name: "Going · 2" })).toHaveAttribute("aria-pressed", "true")
  expect(new URL(other.url()).hash).toBe("")
  await Promise.all([one.close(), two.close()])
})

test("a code shown on one device, typed on another, links them as one person", async ({ page, browser, fixture }) => {
  // Three map pages over two devices, which Chromium draws in software: nothing here waits on a clock, but the whole
  // takes more than one page's budget when every core is busy with the other tests
  test.slow()
  await openMap(page, fixture.origin)
  const path = await makePin(page, "Linked pin")
  const other = await stranger(browser)
  const laptop = await other.newPage()
  await openMap(laptop, fixture.origin)
  await laptop.getByRole("button", { name: "You", exact: true }).click()
  await laptop.getByRole("button", { name: "Show a code on this device" }).click()
  const code = (await laptop.locator(".code").textContent())!
  expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)
  await expect(laptop.getByRole("img", { name: `QR code for ${code}` })).toBeVisible()
  await shoot(laptop, "link-code")

  // The phone opens the code's link, as scanning the QR does, and approves it
  await page.goto(`${fixture.origin}/map/#link=${code.replace("-", "").toLowerCase()}`)
  await expect(page.getByLabel("Code from another device")).toHaveValue(code.replace("-", "").toUpperCase())
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByText("Approved.")).toBeVisible()
  // Back on the laptop, which asks at once rather than at its next poll, however loaded the machine
  await laptop.bringToFront()
  await laptop.evaluate(() => dispatchEvent(new FocusEvent("focus")))
  await expect(laptop.getByText("Linked.")).toBeVisible()
  // The laptop is the pin's maker now
  await laptop.goto(fixture.origin + path)
  await expect(laptop.getByRole("button", { name: "Delete this event" })).toBeVisible()
  await other.close()
})

test("approving a code shown by a verified device shows its address on the approving one, without a reload", async ({ page, browser, fixture }) => {
  // Two devices' map pages, drawn in software beside the other tests
  test.slow()
  // The laptop verifies an address, then shows a code
  const other = await stranger(browser)
  const laptop = await other.newPage()
  await openMap(laptop, fixture.origin)
  await laptop.getByRole("button", { name: "You", exact: true }).click()
  await laptop.getByLabel("UNH email").fill("bo@unh.edu")
  await laptop.getByRole("button", { name: "Send code" }).click()
  await expect(laptop.getByText("Code sent to bo@unh.edu")).toBeVisible()
  const mail = await (await fetch(`${worker!.origin}/__mail`)).json() as { subject: string }
  await laptop.getByLabel("Code from the email").fill(mail.subject.slice(0, 6))
  await laptop.getByRole("button", { name: "Confirm" }).click()
  await expect(laptop.getByText("Verified as")).toBeVisible()
  await laptop.getByRole("button", { name: "Show a code on this device" }).click()
  const code = (await laptop.locator(".code").textContent())!

  // The phone, verified as nobody, approves it, and is bo@unh.edu at once
  await openMap(page, fixture.origin)
  await page.getByRole("button", { name: "You", exact: true }).click()
  await page.getByLabel("Code from another device").fill(code)
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByText("Approved.")).toBeVisible()
  await expect(page.getByText("Verified as")).toContainText("bo@unh.edu")
  await other.close()
})

test("a code emailed to a UNH address verifies this device once typed back, which lets it list a pin on the map", async ({ page, fixture }) => {
  await openMap(page, fixture.origin)
  await page.getByRole("button", { name: "You", exact: true }).click()
  await page.getByLabel("UNH email").fill("ana@wildcats.unh.edu")
  await page.getByRole("button", { name: "Send code" }).click()
  await expect(page.getByText("Code sent to ana@wildcats.unh.edu")).toBeVisible()
  const mail = await (await fetch(`${worker!.origin}/__mail`)).json() as { to: string, subject: string }
  expect(mail.to).toBe("ana@wildcats.unh.edu")
  await page.getByLabel("Code from the email").fill(mail.subject.slice(0, 6))
  await page.getByRole("button", { name: "Confirm" }).click()
  await expect(page.getByText("Verified as")).toBeVisible()
  await page.getByRole("button", { name: "Back to Map" }).click()
  await page.getByRole("button", { name: "New event" }).click()
  const listed = page.getByRole("button", { name: "Everyone", exact: true })
  await expect(listed).toBeEnabled()
  await listed.click()
  await page.getByLabel("What").fill("Open mic")
  await page.locator("input[name=place]").fill("Memorial Union Building")
  // From this hour, so it's under way and on today's list whatever the time this runs
  await fillWhen(page, 0, Math.floor(Date.now() / 3_600_000) * 3_600_000)
  await page.getByRole("button", { name: "Post it" }).click()
  await expect(page.getByRole("heading", { name: "Open mic" })).toBeVisible()
  // Listed on today's map for everyone
  await page.goto(fixture.origin + "/map/")
  await expect(page.getByRole("list", { name: "Now" }).locator(".row", { hasText: "Open mic" })).toBeVisible()
  await shoot(page, "today-with-pin")
})

test("a permit set on one of two linked devices reaches the other, and comes back to one whose storage was cleared, by its cookie", async ({ page, browser, fixture }) => {
  // A dozen map pages over two devices, each drawn in software beside the other tests: past test.slow()'s 90 s on a
  // busy machine, though nothing waits on a clock
  test.setTimeout(180_000)
  const parking = `${fixture.origin}/map/?parking=Kingsbury+Hall`
  const permitOf = (on: Page) => on.locator(".view .parking-ask summary")
  /** The device's id, as its storage keeps it */
  const deviceOf = (on: Page) => on.evaluate(async () => (await (await (await caches.open("reminders-v1")).match("/reminders.json"))?.json())?.device?.id as string | undefined)
  /** The page opened again until it says what's asked, as the other device's write reaches the Worker within a moment */
  const reaches = (on: Page, text: string) =>
    expect(async () => {
      await on.goto(parking)
      await expect(permitOf(on)).toContainText(text, { timeout: 2000 })
    }).toPass({ timeout: 20_000 })

  // Two devices, linked as one person
  await openMap(page, fixture.origin)
  const other = await stranger(browser)
  const laptop = await other.newPage()
  await openMap(laptop, fixture.origin)
  await laptop.getByRole("button", { name: "You", exact: true }).click()
  await laptop.getByRole("button", { name: "Show a code on this device" }).click()
  const code = (await laptop.locator(".code").textContent())!
  // A link of its own, as the phone's camera opens it, rather than a fragment on the page it's on
  await page.goto(`${fixture.origin}/map/?you#link=${code.replace("-", "")}`)
  await page.getByRole("button", { name: "Approve" }).click()
  await expect(page.getByText("Approved.")).toBeVisible()

  // The phone sets a permit, and the laptop has it
  await page.goto(parking)
  await permitOf(page).click()
  await page.locator(".view").getByLabel("Permit", { exact: true }).selectOption("faculty")
  await expect(permitOf(page)).toContainText("faculty/staff")
  await reaches(laptop, "faculty/staff")

  // The laptop's storage is cleared, its id and secret with it, but not the Worker's cookie, with no page of the app
  // open to write anything back meanwhile: it's itself again, with the permit
  const id = await deviceOf(laptop)
  expect(id).toBeDefined()
  await laptop.close()
  const cleared = await other.newPage()
  await cleared.goto(`${fixture.origin}/icon.svg`)
  await cleared.evaluate(async () => {
    localStorage.clear()
    await caches.delete("reminders-v1")
  })
  expect(await cleared.evaluate(() => caches.has("reminders-v1"))).toBe(false)
  await reaches(cleared, "faculty/staff")
  await expect.poll(() => deviceOf(cleared), { timeout: 10_000 }).toBe(id)

  // And what it sets now reaches the phone
  await permitOf(cleared).click()
  await cleared.locator(".view").getByLabel("Permit", { exact: true }).selectOption("commuter")
  await reaches(page, "commuter")
  await other.close()
})
