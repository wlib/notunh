// What each cron trigger runs, and for the sources that are sampled, storing what one saw in a minute and every poll
// it made to see it as a gzipped row in samples, so a minute polled is a row even when nothing was seen

import { encode, type RawPoll } from "../src/transit/observations/raw.mts"
import { samples } from "./schema.mts"
import { inserts } from "./rows.mts"

/** Who's asking, for Umo, which refuses a request without a User-Agent */
export const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

export type Env = {
  DB:                   D1Database,
  /** The built site, for the pages the Worker answers for itself */
  ASSETS:               Fetcher,
  /** How many days of samples and laundry transitions the nightly run keeps */
  RETAIN_DAYS:          number,
  /** How many days of samples it keeps of days the observations archive has (src/transit/observations/archive.mts) */
  RETAIN_ARCHIVED_DAYS: number,
  /** How many days of the visits extracted from samples it keeps */
  RETAIN_VISIT_DAYS:    number,
  /** How many days of the location model's daily summaries it keeps */
  RETAIN_SUMMARY_DAYS:  number,
  /** Workers Builds' deploy hook, a secret */
  DEPLOY_HOOK?:         string,
  /** Lets the build read and write rows and models through /api/, so it needs no D1 credentials, a secret */
  BUILD_TOKEN?:         string,
  /** A GitHub token with the actions scope, a secret, for the nightly run to start the Observations and Map data workflows */
  GITHUB_TOKEN?:        string
}

/** What a cron trigger runs, given the epoch milliseconds its minute started at and a signal for the minute running out */
export type Job = {
  /** The trigger in wrangler.jsonc, exactly as written there; each trigger gets its own 10 ms of CPU */
  cron: string,
  run:  (env: Env, at: number, signal: AbortSignal) => Promise<unknown>
}

/** What a source saw in a minute, and every poll it made, failed ones too */
export type Collected<T> = { samples: T[], polls: RawPoll[] }

export type Source<T = unknown> = {
  name: string,
  cron: string,
  /** What it saw in the minute starting at an instant, where no polls store no row */
  collect: (at: number, signal: AbortSignal) => Promise<Collected<T>>
}

/** A source's minute as a job: what it saw and its polls, gzipped, in one row */
export const sampling = ({ name, cron, collect }: Source): Job => ({
  cron,
  run: async (env, at, signal) => {
    const { samples: seen, polls } = await collect(at, signal)
    if (polls.length)
      await env.DB.batch(inserts(env.DB, samples, [{ source: name, at, body: await encode(seen, polls) }], [samples.source, samples.at]))
  }
})
