// What each cron trigger runs, and for the sources that are sampled, storing what one saw in a minute as a gzipped
// row in samples

import { encode } from "../src/map/raw.mts"
import { samples } from "./schema.mts"
import { inserts } from "./rows.mts"

/** Who's asking, for Umo, which refuses a request without a User-Agent */
export const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

export type Env = {
  DB:                D1Database,
  /** The built site, for the pages the Worker answers for itself */
  ASSETS:            Fetcher,
  /** How many days of samples and laundry transitions the nightly run keeps */
  RETAIN_DAYS:       number,
  /** How many days of the visits extracted from samples it keeps */
  RETAIN_VISIT_DAYS: number,
  /** Workers Builds' deploy hook, a secret */
  DEPLOY_HOOK?:      string,
  /** Lets the build read and write rows and models through /api/, so it needs no D1 credentials, a secret */
  BUILD_TOKEN?:      string
}

/** What a cron trigger runs, given the epoch milliseconds its minute started at and a signal for the minute running out */
export type Job = {
  /** The trigger in wrangler.jsonc, exactly as written there; each trigger gets its own 10 ms of CPU */
  cron: string,
  run:  (env: Env, at: number, signal: AbortSignal) => Promise<unknown>
}

export type Source<T = unknown> = {
  name: string,
  cron: string,
  /** What it saw in the minute starting at an instant, where nothing stores no row */
  collect: (at: number, signal: AbortSignal) => Promise<T[]>
}

/** A source's minute as a job: what it saw, gzipped, in one row */
export const sampling = ({ name, cron, collect }: Source): Job => ({
  cron,
  run: async (env, at, signal) => {
    const seen = await collect(at, signal)
    if (seen.length)
      await env.DB.batch(inserts(env.DB, samples, [{ source: name, at, body: await encode(seen) }], [samples.source, samples.at]))
  }
})
