// Learns the bus model in the build through scripts/learn.mts, and writes src/map/model.json for the map to bundle.
// Each whole service day is summed up (fit.mts summarize) from the visits its fixes show, read from the day's archive
// or the Worker while it keeps them (scripts/observations.mts), or else from the visits stored then. The summary
// includes how forecasts did that day, scored against the timetable then in force. A feed version the build hasn't
// seen before is archived in the Worker first (replay.mts). The visits and the summary are stored, and the summary
// folded in. A day summed up before by this extractor into this shape is folded in as it was. With --rebuild (or
// MODEL_REBUILD=1), the model is learned afresh from the first day there's anything of, refolding the stored
// summaries where they're kept. --local uses `wrangler dev`

import { serviceDayStart } from "../../src/transit/feed.mts"
import { fetchCatalog } from "../../src/transit/observations/archive.mts"
import { EXTRACTOR, type Visit } from "../../src/transit/inference/events.mts"
import { type Model, emptyModel } from "../../src/transit/models/model.mts"
import { fold, summarize } from "../../src/transit/models/fit.mts"
import { type Day, localDay } from "../../src/shared/time.mts"
import { lastSettled } from "../observations.mts"
import { isRebuild, learn } from "../learn.mts"
import { ApiError, health, readRows, writeRows } from "../worker.mts"
import { archiveFeed, describe, extractDay, feedFor, localFeed, score } from "./replay.mts"

const OUTPUT = new URL("../../src/map/model.json", import.meta.url)

/** A service day's summary as the Worker keeps it, by the model's shape and the extractor its visits were read by */
type Summary = { at: number, version: number, extractor: number, state: Model }

/**
 * The Worker's summaries, or none from a Worker without the summaries table: a build runs before its own Worker
 * deploys
 */
const summaries = {
  read:  (day: Day) => readRows<Summary>("summaries", day).catch(error => isMissing(error) ? [] : Promise.reject(error)),
  write: (day: Day, summary: Summary) => writeRows("summaries", [summary], day).catch(error => isMissing(error) ? undefined : Promise.reject(error))
}

const isMissing = (error: unknown) =>
  error instanceof ApiError && error.status === 404


const today = localDay(Date.now())

// The first day archived or with samples in the Worker, and the first with stored visits, asked once there's a day
// to learn
let firsts: Promise<{ observed?: Day, stored?: Day }> | undefined
const firstDays = () =>
  firsts ??= Promise.all([health(), fetchCatalog()]).then(([{ buses, visits }, { days }]) => ({
    observed: [days[0]?.day, buses.since === null ? undefined : localDay(buses.since)].filter(day => day !== undefined).sort()[0],
    stored:   visits.since === null ? undefined : localDay(visits.since * 1000)
  }))

const model = await learn("buses", OUTPUT, {
  empty: emptyModel,
  // The timetable is archived as of the day a learning build first sees it. A build only reading doesn't archive it
  prepare: async learning => {
    if (learning && await archiveFeed(await localFeed(), today))
      console.log(`buses: archived the timetable`)
  },
  first: async () => {
    const { observed, stored } = await firstDays()
    return [observed, isRebuild() ? stored : undefined].filter(day => day !== undefined).sort()[0]
  },
  last:  lastSettled(Date.now()),
  fold:  async (model, day, storedThrough) => {
    // A day summed up before, by this extractor into this shape, is folded in as it is, so a refit, or another
    // half-life, needs no extracting
    const summed = (await summaries.read(day)).find(row => row.version === model.version && row.extractor === EXTRACTOR)
    if (summed) {
      console.log(`buses: ${day}, as summed up before`)
      return fold(model, day, summed.state)
    }
    const feed = await feedFor(day)
    // From the day's fixes, archived or still in the Worker, else the visits it stored then, if this extractor read
    // them
    const observed = await extractDay(feed, day)
    const isObserved = observed.fixes.length > 0
    const { visits, fixes } = isObserved
      ? observed
      : { visits: (await readRows<Visit>("visits", day)).filter(visit => (visit.extractor ?? 1) === EXTRACTOR), fixes: undefined }
    // Days the stored model covers had their visits stored then. A rebuild, or a refit of a model of an older shape,
    // leaves them be, as storing them all again would take far more than D1's daily write allowance
    if (isObserved && day > (storedThrough ?? ""))
      await writeRows("visits", visits, day)
    const summary = summarize(visits, score(model, feed, visits, fixes))
    await summaries.write(day, { at: serviceDayStart(day), version: model.version, extractor: EXTRACTOR, state: summary })
    console.log(`buses: ${day}, ${visits.length} visits`)
    return fold(model, day, summary)
  },
  // Of the build's 20 minutes, what fitting can take
  budgetMs: 8 * 60_000
})

if (model)
  console.log(describe(model.scores))
