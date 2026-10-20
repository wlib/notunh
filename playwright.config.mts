// The service worker through real browsers (tests/browser/), apart from vitest: `npm run test:browser`, after
// `npx playwright install chromium webkit` once. The site is built once into a temporary folder first

import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.browser.mts",
  globalSetup: "./tests/browser/setup.mts",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "webkit",   use: devices["Desktop Safari"] }
  ]
})
