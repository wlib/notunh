// The question of usage stats, as a first visit sees it

import { test as base, expect } from "@playwright/test"
import { type Fixture, startFixture } from "./fixture.mts"

const test = base.extend<{ fixture: Fixture }>({
  fixture: async ({}, use) => {
    const fixture = await startFixture(process.env.NOTUNH_DIST!)
    await use(fixture)
    await fixture.close()
  }
})

test("a first visit is asked once, the answer is the home page's setting, and nothing of PostHog loads off notunh.app", async ({ page, fixture }) => {
  const posthog: string[] = []
  page.on("request", request => /posthog/.test(request.url()) && posthog.push(request.url()))
  await page.goto(`${fixture.origin}/dining/`)
  await page.getByRole("button", { name: "Sure" }).click()
  await expect(page.locator(".usage-prompt")).toHaveCount(0)

  await page.goto(`${fixture.origin}/`)
  await expect(page.locator(".usage-prompt")).toHaveCount(0)
  await expect(page.getByLabel("Share usage stats")).toBeChecked()
  await page.getByLabel("Share usage stats").uncheck()
  await page.reload()
  await expect(page.getByLabel("Share usage stats")).not.toBeChecked()
  await expect(page.locator(".usage-prompt")).toHaveCount(0)
  expect(posthog).toEqual([])
})

test("a browser with Global Privacy Control isn't asked, and its setting says why", async ({ page, fixture }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "globalPrivacyControl", { value: true }))
  await page.goto(`${fixture.origin}/`)
  await expect(page.locator(".usage-prompt")).toHaveCount(0)
  await expect(page.getByLabel("Share usage stats")).toBeDisabled()
  await expect(page.getByText("Global Privacy Control")).toBeVisible()
})
