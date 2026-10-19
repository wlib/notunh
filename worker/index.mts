// The Worker behind notunh.app's static assets: cron triggers that keep raw samples of the live APIs and laundry's
// changes in D1, a nightly one that prunes what's past keeping and rebuilds the site, and the routes in api.mts

import { localDay, weekday } from "../src/shared/time.mts"
import { HEADERS, sampling, type Env, type Job } from "./collect.mts"
import { app } from "./api.mts"
import { prune } from "./rows.mts"
import { buses } from "./buses.mts"
import { predictions } from "./predictions.mts"
import { collector } from "./laundry.mts"

// As written in wrangler.jsonc: 4:17 AM in Durham (EDT), before anyone's looking for a bus
const NIGHTLY = "17 8 * * *"

// A run past this would overlap the next minute's
const DEADLINE_MS = 58_000

// The Map data workflow, which GitHub stops scheduling after 60 days without a commit, so Monday's nightly run
// starts it too, given a token; a run that finds its generation published already makes nothing
const MAP_DATA = "https://api.github.com/repos/wlib/notunh/actions/workflows/map.yml/dispatches"
const MONDAY = 0

const post = async (url: string, init: RequestInit, what: string) => {
  const response = await fetch(url, { ...init, method: "POST" })
  if (!response.ok)
    throw new Error(`${what} ${response.status}`)
}

const nightly = async (env: Env, at: number) => {
  const today = localDay(at)
  await prune(env, today)
  // A dispatch that fails, as with a token run out, is logged, and the night's rebuild still goes ahead
  if (env.GITHUB_TOKEN && weekday(today) === MONDAY)
    await post(MAP_DATA, {
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": HEADERS["user-agent"] },
      body:    JSON.stringify({ ref: "main" })
    }, "Map data dispatch").catch(console.error)
  // Workers Builds rebuilds main with a fresh timetable and menus, and with whatever the build learns from samples
  if (!env.DEPLOY_HOOK) {
    console.warn("No DEPLOY_HOOK secret, so the site isn't rebuilt")
    return
  }
  await post(env.DEPLOY_HOOK, {}, "Deploy hook")
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
