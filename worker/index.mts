// The Worker behind notunh.app's static assets: cron triggers that keep raw samples of the live APIs and laundry's
// changes in D1, a nightly one that prunes what's past keeping and rebuilds the site, and the routes in api.mts

import { CATALOG, fetchCatalog } from "../src/map/archive.mts"
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

// The workflows GitHub stops scheduling after 60 days without a commit, so the nightly run starts them too, given
// a token: Observations every night, which archives the samples before D1 drops them, and Map data on Mondays. A
// run that finds its work published already does nothing
const WORKFLOWS = "https://api.github.com/repos/wlib/notunh/actions/workflows/"
const MONDAY = 0

// A catalog taking longer has stalled
const CATALOG_MS = 10_000

const post = async (url: string, init: RequestInit, what: string) => {
  const response = await fetch(url, { ...init, method: "POST" })
  if (!response.ok)
    throw new Error(`${what} ${response.status}`)
}

/** The days the observations archive has, or none when its catalog can't be read, so no samples go early */
const archivedDays = () =>
  fetchCatalog({ headers: HEADERS, signal: AbortSignal.timeout(CATALOG_MS) }).then(
    ({ days }) => days.map(({ day }) => day),
    error => {
      console.warn(`Couldn't read ${CATALOG}, so samples are kept their full RETAIN_DAYS`, error)
      return []
    }
  )

const nightly = async (env: Env, at: number) => {
  const today = localDay(at)
  await prune(env, today, await archivedDays())
  // A dispatch that fails, as with a token run out, is logged, and the night's rebuild still goes ahead
  if (env.GITHUB_TOKEN)
    for (const workflow of weekday(today) === MONDAY ? ["archive.yml", "map.yml"] : ["archive.yml"])
      await post(`${WORKFLOWS}${workflow}/dispatches`, {
        headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": HEADERS["user-agent"] },
        body:    JSON.stringify({ ref: "main" })
      }, `${workflow} dispatch`).catch(console.error)
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
