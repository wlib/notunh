// The Worker behind notunh.app's static assets: cron triggers that keep raw samples of the live APIs and laundry's
// changes in D1, a nightly one that prunes what's past keeping and rebuilds the site, and the routes in api.mts

import { localDay } from "../src/shared/time.mts"
import { sampling, type Env, type Job } from "./collect.mts"
import { app } from "./api.mts"
import { prune } from "./rows.mts"
import { buses } from "./buses.mts"
import { predictions } from "./predictions.mts"
import { collector } from "./laundry.mts"

// As written in wrangler.jsonc: 4:17 AM in Durham (EDT), before anyone's looking for a bus
const NIGHTLY = "17 8 * * *"

// A run past this would overlap the next minute's
const DEADLINE_MS = 58_000

const nightly = async (env: Env, at: number) => {
  await prune(env, localDay(at))
  // Workers Builds rebuilds main with a fresh timetable and menus, and with whatever the build learns from samples
  if (!env.DEPLOY_HOOK) {
    console.warn("No DEPLOY_HOOK secret, so the site isn't rebuilt")
    return
  }
  const response = await fetch(env.DEPLOY_HOOK, { method: "POST" })
  if (!response.ok)
    throw new Error(`Deploy hook ${response.status}`)
}

const jobs: Job[] = [sampling(buses), sampling(predictions), collector, { cron: NIGHTLY, run: nightly }]

export default {
  fetch: app.fetch,

  scheduled: async (controller, env) => {
    const job = jobs.find(job => job.cron === controller.cron)
    if (!job)
      throw new Error(`No job for the trigger ${controller.cron}`)
    // The minute's start, which a trigger fires at, give or take
    await job.run(env, Math.floor(controller.scheduledTime / 60_000) * 60_000, AbortSignal.timeout(DEADLINE_MS))
  }
} satisfies ExportedHandler<Env>
