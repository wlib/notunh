// What each cron trigger runs. A sampled source stores what it saw in a minute, plus every poll it made, as one
// gzipped row in samples, so a polled minute is a row even when nothing was seen

import { encode, type RawPoll } from "../src/transit/observations/raw.mts"
import { samples } from "./schema.mts"
import { inserts } from "./rows.mts"
import type { Env } from "./env.mts"
import { SITE } from "../src/shared/site.mts"

/** Who's asking, for Umo, which refuses a request without a User-Agent. Never sent to the laundry vendor */
export const HEADERS = { "user-agent": `notunh/1 (+${SITE})` }

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
