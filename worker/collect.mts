// What each cron trigger runs. A sampled source stores what it saw in a minute, plus every poll it made, as one
// gzipped row in samples, so a polled minute is a row even when nothing was seen

import { encode, type RawPoll } from "../src/transit/observations/raw.mts"
import { samples } from "./schema.mts"
import { inserts } from "./rows.mts"

/** Who's asking, for Umo, which refuses a request without a User-Agent. Never sent to the laundry vendor */
export const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

export type Env = {
  DB:                     D1Database,
  /** The built site, for the pages the Worker answers for itself */
  ASSETS:                 Fetcher,
  /** How many days of laundry's transitions and polls the nightly run keeps */
  RETAIN_DAYS:            number,
  /** How many days of samples it keeps once the observations archive has their day (src/transit/observations/archive.mts) */
  RETAIN_ARCHIVED_DAYS:   number,
  /** How many days of the visits extracted from the observations it keeps */
  RETAIN_VISIT_DAYS:      number,
  /** How many days of daily statistics and evaluations it keeps */
  RETAIN_STATISTICS_DAYS: number,
  /** Lets the workflows read and write rows and models through /api/, so they need no D1 credentials, a secret */
  BUILD_TOKEN?:           string,
  /** A GitHub token that can start the workflows, a secret, for the nightly run to start them */
  GITHUB_TOKEN?:          string,
  /** Each device's reminders (reminders.mts), where they're set up, which Previews aren't */
  REMINDERS?:             DurableObjectNamespace,
  /** The VAPID key pair reminders are pushed with (push.mts), base64url, both secrets */
  VAPID_PUBLIC_KEY?:      string,
  VAPID_PRIVATE_KEY?:     string,
  /** Who push services can reach about our pushes, a mailto: or https: URL */
  VAPID_SUBJECT?:         string
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
