// A program's courses by what each needs, from the build's program fixtures (tests/fixtures/programs/programs/): on a
// phone the lanes stack and a tapped course lights its chain, says what it needs in a card below it and links to its
// page, and Back returns to the graph focused as it was; a pool of choices opens to its courses; a program with a
// sample plan lays the same courses out by term; a course's page names its programs; the list of programs is
// searched by title; a program whose lists can't be read for sure lists its courses instead; and on a wide screen the
// lanes sit side by side with every edge drawn and the card at the top. Screenshots go to NOTUNH_SHOTS when it's set

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect, devices, type Page } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

const { defaultBrowserType, ...phone } = devices["iPhone 13"]
test.use({ ...phone, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }, timezoneId: "America/New_York", serviceWorkers: "block" })

const SHOTS = process.env.NOTUNH_SHOTS
if (SHOTS)
  mkdirSync(SHOTS, { recursive: true })
const shoot = (page: Page, name: string) =>
  SHOTS ? page.screenshot({ path: join(SHOTS, `${name}-${test.info().project.name}.png`) }) : Promise.resolve()

const open = async (page: Page, origin: string, path: string) => {
  await page.goto(origin + path)
  const no = page.getByRole("button", { name: "No", exact: true })
  await no.waitFor({ timeout: 3000 }).then(() => no.click(), () => {})
}

test("on a phone, tapping a course lights its chain, says what it needs below it, and opens its page, which Back returns from", async ({ page, fixture }) => {
  // The graph is drawn, lit, left for the course's page and come back to, which takes a while on a busy machine
  test.slow()
  await open(page, fixture.origin, "/map/?program=computer-science-minor")
  const view = page.locator(".view")
  await expect(view.getByRole("heading", { name: "Computer Science Minor" })).toBeVisible()
  await expect(view.getByRole("link", { name: /catalog ›$/ })).toHaveAttribute("href", /catalog\.unh\.edu\/undergraduate\/.+\/computer-science-minor\/$/)
  // No plan, so no view by term
  await expect(view.getByRole("button", { name: "By term" })).toHaveCount(0)
  // Stacked: each level under the one before
  const levels = view.locator(".level")
  expect(await levels.count()).toBeGreaterThan(2)
  const [first, second] = [await levels.nth(0).boundingBox(), await levels.nth(1).boundingBox()]
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1)
  // No edges until a course is tapped
  await expect(view.locator(".edge.on")).toHaveCount(0)

  const node = view.locator('.node[data-code="CS 515"]')
  await node.click()
  await expect(page).toHaveURL(/\?program=computer-science-minor&course=CS\+515$/)
  // The card follows the course in its lane, below it, and the one for a wide screen is hidden
  const focus = view.locator(".focus-inline .program-focus")
  await expect(focus).toBeVisible()
  await expect(view.locator(".focus-top")).toBeHidden()
  expect((await focus.boundingBox())!.y).toBeGreaterThan((await node.boundingBox())!.y)
  await expect(focus).toContainText("CS 515")
  await expect(focus).toContainText("CS 416")
  await expect(node).toHaveAttribute("aria-pressed", "true")
  await expect(view.locator('.node[data-code="CS 416"]')).toHaveAttribute("data-chain", "needs")
  // What it unlocks here is the pool of choices, lit as one node, and its courses once it's open
  await expect(view.locator('.node[data-code="pool-1"]')).toHaveAttribute("data-chain", "unlocks")
  expect(await view.locator(".edge.on").count()).toBeGreaterThan(0)
  await view.locator('.node[data-code="pool-1"]').click()
  await expect(view.locator('.node[data-code="CS 619"]')).toHaveAttribute("data-chain", "unlocks")
  await shoot(page, "program-focused")

  await focus.locator(".line", { hasText: "Sections" }).getByRole("button").click()
  await expect(page).toHaveURL(/\?course=CS\+515$/)
  await page.getByRole("button", { name: /^Back to / }).click()
  await expect(page).toHaveURL(/\?program=computer-science-minor&course=CS\+515$/)
  await expect(view.locator(".focus-inline .program-focus")).toContainText("CS 515")
  await view.getByRole("button", { name: "Clear focus" }).click()
  await expect(page).toHaveURL(/\?program=computer-science-minor$/)
  await expect(view.locator(".program-focus")).toHaveCount(0)
})

test("a pool of choices is one node that opens to its courses, and a course opened from its page opens its pool", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/?program=computer-science-major-bs")
  const view = page.locator(".view")
  const pool = view.locator(".node.pool", { hasText: "implementation electives" })
  await expect(pool).toHaveAttribute("aria-expanded", "false")
  await expect(pool).toContainText("8 choices")
  await expect(view.locator('.node[data-code="CS 712"]')).toHaveCount(0)
  // The choices aren't nodes of their own, nor are the sciences they'd need
  await expect(view.locator('.node[data-code="BIOL 411"]')).toHaveCount(0)
  await pool.click()
  await expect(pool).toHaveAttribute("aria-expanded", "true")
  await expect(view.locator('.node[data-code="CS 712"]')).toBeVisible()
  await shoot(page, "program-pool")
  // Opened from a course's page, focused on a choice, the pool is open
  await open(page, fixture.origin, "/map/?program=computer-science-major-bs&course=CS+712")
  await expect(view.locator('.node[data-code="CS 712"]')).toHaveAttribute("aria-pressed", "true")
  await expect(view.locator(".program-focus").first()).toContainText("A choice")
  // Notes with nothing under them are listed below the graph
  await expect(view.locator(".program-also")).toContainText("Select three additional CS courses numbered 690-799")
})

test("a program with a sample plan lays the same courses out by term, and the rest in a last lane", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/?program=computer-science-major-bs&course=CS+619")
  const view = page.locator(".view")
  const before = await view.locator(".node").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.code).sort())
  await view.getByRole("button", { name: "By term" }).click()
  const labels = view.locator(".level h3")
  await expect(labels.first()).toHaveText("First Year · Fall")
  await expect(labels.last()).toHaveText("Not in the plan")
  const level = (code: string) => view.locator(".level", { has: page.locator(`.node[data-code="${code}"]`) }).locator("h3")
  await expect(level("CS 415")).toHaveText("First Year · Fall")
  // An alternative sits with the course the plan names in its place
  await expect(level("CS 410C")).toHaveText("First Year · Fall")
  await expect(level("CS 792")).toHaveText("Fourth Year · Spring")
  await expect(view.locator(".level", { hasText: "Not in the plan" }).locator(".node.pool")).toHaveCount(2)
  // The same nodes, the focus kept, the chain still drawn
  expect(await view.locator(".node").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.code).sort())).toEqual(before)
  await expect(view.locator('.node[data-code="CS 619"]')).toHaveAttribute("aria-pressed", "true")
  expect(await view.locator(".edge.on").count()).toBeGreaterThan(0)
  await shoot(page, "program-terms")
})

test("a course's page names how many programs list it, which open the list of them, each opening focused on it", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/?course=CS+515")
  await page.getByRole("button", { name: /^In \d+ programs ›$/ }).click()
  await expect(page).toHaveURL(/\?program=&course=CS\+515$/)
  await page.getByRole("list", { name: "Programs with CS 515" }).getByRole("button", { name: /^Computer Science Minor/ }).click()
  await expect(page).toHaveURL(/\?program=computer-science-minor&course=CS\+515$/)
  await expect(page.locator(".program-focus").first()).toContainText("CS 515")
})

test("the programs are searched by title, and one whose lists can't be read for sure lists its courses", async ({ page, fixture }) => {
  await open(page, fixture.origin, "/map/?program=")
  const view = page.locator(".view")
  await view.getByRole("searchbox", { name: "Search programs" }).fill("political")
  await view.getByRole("button", { name: /^Political Science Major \(B\.A\.\)/ }).click()
  await expect(page).toHaveURL(/\?program=political-science-major-ba$/)
  await expect(view).toContainText("the catalog's to say")
  await expect(view.locator(".node")).toHaveCount(0)
  await expect(view.getByRole("button", { name: /POLT 500/ })).toBeVisible()
})

test.describe("on a wide screen", () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false })

  test("the lanes sit side by side sharing the width, with every edge drawn, the chain's standing out and the card at the top", async ({ page, fixture }) => {
    // The major's whole graph, drawn and redrawn as the chain lights, takes a while on a busy machine
    test.slow()
    await open(page, fixture.origin, "/map/?program=computer-science-major-bs")
    const view = page.locator(".view")
    const levels = view.locator(".level")
    await expect(levels.nth(1)).toBeVisible()
    const [first, second] = [await levels.nth(0).boundingBox(), await levels.nth(1).boundingBox()]
    expect(second!.x).toBeGreaterThan(first!.x + first!.width - 1)
    // Seven levels fit the panel without scrolling sideways
    const graph = view.locator(".graph")
    expect(await graph.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await expect(view.locator(".edge").first()).toBeVisible()
    await view.locator('.node[data-code="CS 619"]').click()
    expect(await view.locator(".edge.on").count()).toBeGreaterThan(1)
    const focus = view.locator(".focus-top .program-focus")
    await expect(focus).toBeVisible()
    await expect(view.locator(".focus-inline")).toBeHidden()
    expect((await focus.boundingBox())!.y).toBeLessThan((await levels.first().boundingBox())!.y)
    await shoot(page, "program-wide")
  })
})
