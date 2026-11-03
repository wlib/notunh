// The map's sheet on a phone holds still: searching lays its suggestions over the week without taking it away or
// changing the sheet's size, and the sheet keeps its height from page to page, Directions and Back included, unless
// it's dragged. A trip's ends are marked only on its directions. A page opens at once, and Back, the sheet's or the
// browser's, returns to the list it was opened from scrolled as it was. The camera following only the page shown is
// tested in tests/map/camera.test.mts and page.test.mts, as the fixtures' map never loads, having no tiles

import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, open, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

// A phone, with every other origin, like Umo and the map's tiles, out of reach
const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, viewport: { width: 390, height: 844 }, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York" })

/** An event today at Huddleston Hall, an hour from now, which the map lists and has a page for */
const HONORS = "test:honors-drop-in"

const withEvent = (page: Page, now: number) =>
  page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: {
    fetched: now,
    events: [{ id: HONORS, title: "Honors Drop In Advising", start: now - 600_000, end: now + 3_600_000, place: "Huddleston Hall", where: "Huddleston Hall", source: "25live", url: "https://example.com/" }]
  } }))

/** A long list of events at Huddleston Hall, every three hours for three weeks from two hours on, "Event 0" first */
const withWeeks = (page: Page, now: number) =>
  page.route(/\/assets\/events-[\w-]+\.json$/, route => route.fulfill({ json: {
    fetched: now,
    events: Array.from({ length: 168 }, (_, i) => ({
      id: `test:event-${i}`, title: `Event ${i}`, start: now + (2 + i * 3) * 3_600_000, end: now + (3 + i * 3) * 3_600_000,
      place: "Huddleston Hall", where: "Huddleston Hall", source: "25live", url: "https://example.com/"
    }))
  } }))

/** How much of the screen the sheet covers, once it's still */
const sheetHeight = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector(".panel")!.classList.contains("moving"))
  return page.evaluate(() => Math.round(innerHeight - document.querySelector(".panel")!.getBoundingClientRect().top))
}

/** How far down the sheet's content is scrolled, once it's still */
const scrollOf = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector(".panel")!.classList.contains("moving"))
  return scrollNow(page)
}

/** How far down the sheet's content is scrolled this instant, mid-drag included */
const scrollNow = (page: Page) =>
  page.evaluate(() => Math.round(document.querySelector(".panel-body")!.scrollTop))

/** Two frames on, by when the sheet has heard of anything that moved it or its content, as it hears of a finger */
const framesOn = (page: Page) =>
  page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/** Scrolls the sheet's content so the row given is in its middle, and says how far down that is */
const scrollToRow = async (page: Page, row: ReturnType<Page["locator"]>) => {
  await row.evaluate(element => element.scrollIntoView({ block: "center" }))
  await framesOn(page)
  return scrollOf(page)
}

/** That the sheet is still the height given once it has heard of whatever might have moved it */
const holds = async (page: Page, height: number) => {
  await framesOn(page)
  expect(await sheetHeight(page)).toBe(height)
}

test("searching lays suggestions over the week, keeping the sheet's size, and clearing it brings the week back as it was", async ({ page, fixture }) => {
  await withEvent(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const search = page.getByPlaceholder("Search campus")
  const week = page.locator(".agenda")
  await expect(page.getByRole("list", { name: "Now" })).toContainText("Honors Drop In Advising")
  const height = await sheetHeight(page)

  // Focus alone changes nothing
  await search.tap()
  await expect(week).toBeVisible()
  await expect(page.locator(".suggested")).toHaveCount(0)
  await holds(page, height)

  // Typing lays the suggestions over the week, which stays, unreachable beneath them
  await search.fill("Kingsbury")
  await expect(page.getByRole("option", { name: "Kingsbury Hall", exact: true })).toBeVisible()
  await expect(week).toHaveAttribute("inert", "")
  await expect(week.getByText("Honors Drop In Advising")).toBeAttached()
  await holds(page, height)

  // Cleared, the week's back, as it was
  await search.fill("")
  await expect(page.locator(".suggested")).toHaveCount(0)
  await expect(week).not.toHaveAttribute("inert", "")
  await expect(page.getByRole("list", { name: "Now" })).toContainText("Honors Drop In Advising")
  await holds(page, height)

  // The keyboard put away, what's typed and its suggestions stay, to be read with the room that leaves
  await search.fill("Kings")
  await search.blur()
  await expect(page.getByRole("option", { name: "Kingsbury Hall", exact: true })).toBeVisible()
  await expect(search).toHaveValue("Kings")
  await holds(page, height)

  // Escape puts them away
  await search.focus()
  await page.keyboard.press("Escape")
  await expect(week).toBeVisible()
  await expect(search).toHaveValue("")
  await holds(page, height)
})

test("the sheet keeps its height through Directions and Back, from home and from a place, and a drag's height after", async ({ page, fixture }) => {
  // Five map pages in one, which Chromium draws in software alongside the other tests
  test.slow()
  await open(page, fixture.origin, "/map/")
  const half = await sheetHeight(page)
  const back = page.locator(".back")

  await page.getByRole("button", { name: "Directions", exact: true }).tap()
  await expect(page.getByPlaceholder("Where to?")).toBeVisible()
  await holds(page, half)
  await back.tap()
  await holds(page, half)

  await page.goto(fixture.origin + "/map/place/Kingsbury+Hall")
  await holds(page, half)
  await page.locator(".view-actions").getByRole("button", { name: "Directions" }).tap()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await holds(page, half)
  await back.tap()
  await expect(page.getByRole("heading", { name: "Kingsbury Hall" })).toBeVisible()
  await holds(page, half)
  await back.tap()
  await holds(page, half)

  // Dragged up by its grabber, it stays that tall from page to page
  const grabber = (await page.locator(".grabber").boundingBox())!
  await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + grabber.height / 2)
  await page.mouse.down()
  await page.mouse.move(grabber.x + grabber.width / 2, 120, { steps: 8 })
  await page.mouse.up()
  const tall = await sheetHeight(page)
  expect(tall).toBeGreaterThan(half + 100)
  await page.getByRole("button", { name: "Directions", exact: true }).tap()
  await holds(page, tall)
  await back.tap()
  await holds(page, tall)
})

test("an event's row opens its page at once: never loading, the week beneath it untouched, and only the page's own dates made", async ({ page, fixture }) => {
  await withWeeks(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const row = page.locator(".agenda").getByRole("button", { name: /Event 30\b/ }).first()
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()

  // What the page costs, from the tap to the frame after its heading is in: whether the view ever said it was loading
  // the event it was opened from, what changed in the week, and the dates made anywhere in the sheet. Once, a page
  // waited on "Loading the event…" while the week's rows and their hundred and more dates were all made again
  type Watched = { loading: boolean, weekChanged: number, datesMade: number }
  await page.evaluate(() => void Object.assign(window, { watched: new Promise<Watched>(resolve => {
    let loading = false
    let weekChanged = 0
    let datesMade = 0
    new MutationObserver(records => weekChanged += records.length).observe(document.querySelector(".agenda")!, { childList: true, subtree: true, characterData: true })
    const shown = new MutationObserver(records => {
      for (const { addedNodes } of records)
        for (const node of addedNodes)
          if (node instanceof Element)
            datesMade += node.querySelectorAll("bruh-date-time").length + (node.matches("bruh-date-time") ? 1 : 0)
      loading ||= document.querySelector(".view")?.textContent?.includes("Loading") ?? false
      if (document.querySelector(".view h1")?.textContent === "Event 30") {
        shown.disconnect()
        requestAnimationFrame(() => resolve({ loading, weekChanged, datesMade }))
      }
    })
    shown.observe(document.querySelector(".panel")!, { childList: true, subtree: true })
  }) }))
  await row.tap()
  const { loading, weekChanged, datesMade } = await page.evaluate(() => (window as unknown as { watched: Promise<Watched> }).watched)
  expect(loading).toBe(false)
  expect(weekChanged).toBe(0)
  // The page says when the event is, in a date or two of its own
  expect(datesMade).toBeGreaterThan(0)
  expect(datesMade).toBeLessThan(10)
  await expect(page.getByRole("heading", { name: "Event 30" })).toBeVisible()
})

test("Back, the sheet's or the browser's, returns to the week and to a place's events scrolled as they were left", async ({ page, fixture }) => {
  test.slow()
  await withWeeks(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const back = page.locator(".back")
  const week = page.locator(".agenda")
  await expect(week.getByRole("button", { name: /Event 30\b/ }).first()).toBeVisible()

  // Further down the week than it first shows, a week later
  await page.getByRole("button", { name: "Later ›" }).tap()
  const later = week.getByRole("button", { name: /Event 70\b/ }).first()
  for (const leave of [() => back.tap(), () => page.goBack()]) {
    const scrolled = await scrollToRow(page, later)
    expect(scrolled).toBeGreaterThan(1000)
    await later.tap()
    await expect(page.getByRole("heading", { name: "Event 70" })).toBeVisible()
    expect(await scrollOf(page)).toBe(0)
    await leave()
    await expect(later).toBeVisible()
    expect(await scrollOf(page)).toBe(scrolled)
  }

  // And Forward to the event, and Back to the week again, each where it was
  await page.goForward()
  await expect(page.getByRole("heading", { name: "Event 70" })).toBeVisible()
  await page.goBack()
  await expect(later).toBeVisible()
  expect(await scrollOf(page)).toBeGreaterThan(1000)

  // A place's page, opened from an event's, and made anew as Back returns to it
  await later.tap()
  await page.locator(".lines").getByRole("button", { name: /Huddleston Hall/ }).tap()
  const there = page.locator(".view").getByRole("button", { name: /Event 15\b/ }).first()
  for (const leave of [() => back.tap(), () => page.goBack()]) {
    const scrolled = await scrollToRow(page, there)
    expect(scrolled).toBeGreaterThan(300)
    await there.tap()
    await expect(page.getByRole("heading", { name: "Event 15" })).toBeVisible()
    await leave()
    await expect(page.getByRole("heading", { name: "Huddleston Hall" })).toBeVisible()
    expect(await scrollOf(page)).toBe(scrolled)
  }
})

test("a trip's ends are marked on the map only while its directions are shown, though Back keeps the trip", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/place/Kingsbury+Hall")
  const ends = page.locator(".maplibregl-marker:not(.focus-marker)")
  await page.locator(".view-actions").getByRole("button", { name: "Directions" }).tap()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await expect(ends).toHaveCount(1)

  await page.locator(".back").tap()
  await expect(page.getByRole("heading", { name: "Kingsbury Hall" })).toBeVisible()
  await expect(ends).toHaveCount(0)
  await page.locator(".back").tap()
  await expect(ends).toHaveCount(0)

  // Directions again still has the trip, marked again
  await page.getByRole("button", { name: "Directions", exact: true }).tap()
  await expect(page.getByPlaceholder("Where to?")).toHaveValue("Kingsbury Hall")
  await expect(ends).toHaveCount(1)
})

test("a tap leaves the sheet as it is, and the page scrolled under it, as iOS does to show a field, goes straight back", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/new")
  const height = await sheetHeight(page)
  const box = () => page.locator(".panel").evaluate(panel => getComputedStyle(panel).getPropertyValue("--sheet-max"))
  const before = await box()
  // Taps on a field's label and on a chip, which the sheet, having nothing to scroll, would take as the start of a drag
  await page.locator(".when-fields legend").first().tap()
  await page.getByRole("button", { name: "Tomorrow" }).first().tap()
  await expect(page.getByRole("button", { name: "Tomorrow" }).first()).toHaveAttribute("aria-pressed", "true")
  expect(await box()).toBe(before)
  await holds(page, height)

  // Made able to scroll, as iOS makes it for the keyboard
  await page.evaluate(() => {
    document.documentElement.style.overflow = "visible"
    document.body.style.blockSize = "200vh"
    scrollTo(0, 120)
  })
  await page.waitForFunction(() => scrollY === 0)
  await holds(page, height)
})

/** Where the sheet is on screen this instant, mid-drag included */
const sheetNow = (page: Page) =>
  page.evaluate(() => Math.round(innerHeight - document.querySelector(".panel")!.getBoundingClientRect().top))

/** A finger's drag from one point straight down or up by some px, let go after resting a moment */
const drag = async (page: Page, x: number, y: number, by: number) => {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + by, { steps: 10 })
  await page.waitForTimeout(150)
  await page.mouse.up()
}

/**
 * A flick: one quick move, let go at once. A browser busy with the other tests may take long enough over it that it's
 * a slow release, which lands back where it was, so it's tried again until the sheet has moved
 */
const flick = async (page: Page, x: number, y: number, by: number) => {
  const from = await sheetHeight(page)
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + by)
    await page.mouse.up()
    if (await sheetHeight(page) !== from)
      return
  }
}

/**
 * A finger on the screen: a real touch through CDP in Chromium, which the browser would scroll the content for unless
 * the sheet keeps it, and the mouse in WebKit, which makes no touches from script. Pressed at a point, moved in steps,
 * each step a function's chance to look, and lifted after resting a moment or at once
 */
const finger = async (page: Page, x: number, y: number, by: number, { steps = 10, rest = 150, onStep }: { steps?: number, rest?: number, onStep?: (step: number) => Promise<unknown> } = {}) => {
  const cdp = test.info().project.name === "chromium" ? await page.context().newCDPSession(page) : undefined
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: number) =>
    cdp!.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: at }] })
  if (cdp)
    await touch("touchStart", y)
  else {
    await page.mouse.move(x, y)
    await page.mouse.down()
  }
  for (let step = 1; step <= steps; step++) {
    const at = y + by * step / steps
    await (cdp ? touch("touchMove", at) : page.mouse.move(x, at))
    await onStep?.(step)
  }
  if (rest)
    await page.waitForTimeout(rest)
  await (cdp ? touch("touchEnd", y + by) : page.mouse.up())
  if (cdp)
    await cdp.detach()
}

test("a pull up from half moves the sheet to tall and runs on into scrolling the content, and a pull down from in the content runs back to its top and on into lowering the sheet", async ({ page, fixture }) => {
  test.slow()
  await withWeeks(page, Date.now())
  await open(page, fixture.origin, "/map/")
  await expect(page.locator(".agenda .row").first()).toBeVisible()
  const half = await sheetHeight(page)
  const tallest = await page.evaluate(() => document.querySelector("#app")!.clientHeight - 4 * parseFloat(getComputedStyle(document.documentElement).fontSize))
  const x = 195
  const grabber = page.locator(".grabber")
  const header = page.locator(".panel-header")
  const headerTop = async () => Math.round((await header.boundingBox())!.y)

  // Up from the content at half: the sheet first, the content still at its top, then at tall the content scrolls,
  // the grabber and header staying put above it throughout
  const seen: { height: number, scroll: number }[] = []
  await finger(page, x, 800, -700, { steps: 14, onStep: async () => seen.push({ height: await sheetNow(page), scroll: await scrollNow(page) }) })
  const rising = seen.filter(({ height }) => height < tallest - 1)
  expect(rising.length).toBeGreaterThan(3)
  for (const { scroll } of rising)
    expect(scroll).toBe(0)
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i].height).toBeGreaterThanOrEqual(seen[i - 1].height)
    expect(seen[i].scroll).toBeGreaterThanOrEqual(seen[i - 1].scroll)
  }
  const tall = await sheetHeight(page)
  expect(tall).toBeGreaterThan(half + 100)
  const scrolled = await scrollOf(page)
  expect(scrolled).toBeGreaterThan(200)
  expect(await headerTop()).toBeLessThan(120)
  await expect(grabber).toBeInViewport()

  // Down from in the content at tall: the content back to its top, the sheet tall throughout, then the sheet down
  const fell: { height: number, scroll: number }[] = []
  await finger(page, x, 300, 500, { steps: 14, onStep: async () => fell.push({ height: await sheetNow(page), scroll: await scrollNow(page) }) })
  const scrolling = fell.filter(({ scroll }) => scroll > 0)
  expect(scrolling.length).toBeGreaterThan(2)
  for (const { height } of scrolling)
    expect(height).toBe(tall)
  const lowering = fell.filter(({ height }) => height < tall - 1)
  expect(lowering.length).toBeGreaterThan(2)
  for (const { scroll } of lowering)
    expect(scroll).toBe(0)
  await holds(page, half)
  expect(await scrollOf(page)).toBe(0)

  // Scrolled down at half, the grabber and header haven't moved, a pull down is the sheet's still, and the content
  // keeps its place until it's lowered
  const top = await headerTop()
  await page.locator(".panel-body").evaluate(element => element.scrollTop = 300)
  await framesOn(page)
  expect(await headerTop()).toBe(top)
  await expect(grabber).toBeInViewport()
  let midway = 0
  await finger(page, x, 700, 120, { onStep: async step => { if (step === 10) midway = await scrollNow(page) } })
  expect(midway).toBe(300)
  await holds(page, half)
})

test("a flick down on the content at its top lowers the sheet, and at tall a pull up is the content's own scroll", async ({ page, fixture }) => {
  test.slow()
  await withWeeks(page, Date.now())
  await open(page, fixture.origin, "/map/")
  const panel = page.locator(".panel")
  await expect(page.locator(".agenda .row").first()).toBeVisible()
  const half = await sheetHeight(page)
  const x = 195

  // Flicked down from the top, it comes down one detent
  for (let attempt = 0; attempt < 12 && await sheetHeight(page) === half; attempt++)
    await finger(page, x, 650, 120, { steps: 2, rest: 0 })
  await expect(panel).toHaveClass(/lowered/)
  expect(await scrollOf(page)).toBe(0)
  await page.locator(".grabber").tap()
  await holds(page, half)

  // At tall, with more to show, a pull up on the content scrolls it: real touches alone scroll in Chromium, and
  // WebKit makes none from script
  const grabber = (await page.locator(".grabber").boundingBox())!
  await finger(page, grabber.x + grabber.width / 2, grabber.y + grabber.height / 2, -(844 - half) * 0.8)
  const tall = await sheetHeight(page)
  expect(tall).toBeGreaterThan(half + 100)
  if (test.info().project.name === "chromium") {
    await finger(page, x, 700, -300)
    await holds(page, tall)
    expect(await scrollOf(page)).toBeGreaterThan(100)
  }

  // Whose a touch is, its first move decides, and the browser is kept from scrolling only for one that's the
  // sheet's: at tall, a pull up with more to show is the content's, and a pull down or a sideways move is not kept.
  // WebKit makes no Touch from script, so Chromium alone checks
  if (test.info().project.name !== "chromium")
    return
  const prevented = (dx: number, dy: number) => page.evaluate(({ x, y, dx, dy }) => {
    const target = document.elementFromPoint(x, y)!
    const touch = (clientX: number, clientY: number) => new Touch({ identifier: 1, target, clientX, clientY })
    const fire = (type: string, clientX: number, clientY: number) => {
      const event = new TouchEvent(type, { touches: [touch(clientX, clientY)], changedTouches: [touch(clientX, clientY)], bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    target.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true }))
    fire("touchstart", x, y)
    const isPrevented = fire("touchmove", x + dx, y + dy)
    target.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 9, pointerType: "touch", bubbles: true }))
    fire("touchend", x + dx, y + dy)
    return isPrevented
  }, { x, y: 500, dx, dy })
  expect(await prevented(0, -3)).toBe(false)
  expect(await prevented(0, 3)).toBe(true)
  expect(await prevented(8, 3)).toBe(false)
  await holds(page, tall)
  // Below tall, either way is the sheet's
  await page.locator(".grabber").tap()
  await page.locator(".grabber").tap()
  await holds(page, half)
  expect(await prevented(0, -3)).toBe(true)
  expect(await prevented(0, 3)).toBe(true)
  await holds(page, half)
})

test("a flick moves the sheet one detent on, and let go after a rest it settles at the nearest", async ({ page, fixture }) => {
  test.slow()
  await open(page, fixture.origin, "/map/")
  const half = await sheetHeight(page)
  const grabber = (await page.locator(".grabber").boundingBox())!
  const x = grabber.x + grabber.width / 2
  const y = grabber.y + grabber.height / 2

  // A short flick down lowers it, and a short flick up brings it to half, never straight to tall
  await flick(page, x, y, 40)
  const lowered = await sheetHeight(page)
  expect(lowered).toBeLessThan(half - 150)
  const low = (await page.locator(".grabber").boundingBox())!
  await flick(page, x, low.y + low.height / 2, -40)
  await holds(page, half)

  // Held a moment before letting go, however far it moved, it rests at the nearest: still half from a little way up
  await drag(page, x, y, -60)
  await holds(page, half)
  // And tall from most of the way there
  const tallest = await page.evaluate(() => document.querySelector("#app")!.clientHeight - 4 * parseFloat(getComputedStyle(document.documentElement).fontSize))
  await drag(page, x, y, -(tallest - half) * 0.8)
  const tall = await sheetHeight(page)
  expect(tall).toBeGreaterThan(half + 100)
  // A flick down from tall is half, not lowered
  const high = (await page.locator(".grabber").boundingBox())!
  await flick(page, x, high.y + high.height / 2, 40)
  await holds(page, half)
})
