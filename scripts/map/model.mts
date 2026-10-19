// Learns the bus model in the build, as scripts/learn.mts does, and writes src/map/model.json for the map to
// bundle. Each whole service day is summed up (model.mts summarize) from the visits its fixes show, read from the
// day's archive or the Worker while it keeps them (scripts/observations.mts), or else from the visits stored then,
// with how forecasts did that day scored, each day against the timetable then in force: a version of the feed the
// build hasn't seen before is archived in the Worker first (replay.mts). The visits and the summary are stored, and
// the summary folded in; a day summed up before by this extractor into this shape is folded in as it was. With
// --rebuild (or MODEL_REBUILD=1), the model is learned afresh from the first day there's anything of, which is
// folding the summaries again where they're kept; --local uses `wrangler dev`

import { serviceDayStart } from "../../src/map/feed.mts"
import { fetchCatalog } from "../../src/map/archive.mts"
import { EXTRACTOR, type Visit } from "../../src/map/events.mts"
import { type Model, emptyModel, fold, summarize } from "../../src/map/model.mts"
import { type Day, localDay } from "../../src/shared/time.mts"
import { lastSettled } from "../observations.mts"
import { isRebuild, learn } from "../learn.mts"
import { ApiError, health, readRows, writeRows } from "../worker.mts"
import { archiveFeed, describe, extractDay, feedFor, localFeed, score } from "./replay.mts"

const OUTPUT = new URL("../../src/map/model.json", import.meta.url)

/** A service day's summary as the Worker keeps it, by the model's shape and the extractor its visits were read by */
type Summary = { at: number, version: number, extractor: number, state: Model }

/** The Worker's summaries, none from one deployed before it kept them, as a build talks to the Worker before its own */
const summaries = {
  read:  (day: Day) => readRows<Summary>("summaries", day).catch(error => isMissing(error) ? [] : Promise.reject(error)),
  write: (day: Day, summary: Summary) => writeRows("summaries", [summary], day).catch(error => isMissing(error) ? undefined : Promise.reject(error))
}

const isMissing = (error: unknown) =>
  error instanceof ApiError && error.status === 404


const today = localDay(Date.now())

// The first days archived, and the Worker has samples and visits for, asked once there's a day to learn
let firsts: Promise<{ observed?: Day, stored?: Day }> | undefined
const firstDays = () =>
  firsts ??= Promise.all([health(), fetchCatalog()]).then(([{ buses, visits }, { days }]) => ({
    observed: [days[0]?.day, buses.since === null ? undefined : localDay(buses.since)].filter(day => day !== undefined).sort()[0],
    stored:   visits.since === null ? undefined : localDay(visits.since * 1000)
  }))

const model = await learn("buses", OUTPUT, {
  empty: emptyModel,
  // The timetable is archived as of the day it's first learned with, which a build only reading doesn't
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
    // half-life, takes no extracting
    const summed = (await summaries.read(day)).find(row => row.version === model.version && row.extractor === EXTRACTOR)
    if (summed) {
      console.log(`buses: ${day}, as summed up before`)
      return fold(model, day, summed.state)
    }
    const feed = await feedFor(day)
    // From the day's fixes, archived or still in the Worker, else the visits it stored then, if this extractor read them
    const observed = await extractDay(feed, day)
    const isObserved = observed.fixes.length > 0
    const { visits, fixes } = isObserved
      ? observed
      : { visits: (await readRows<Visit>("visits", day)).filter(visit => (visit.extractor ?? 1) === EXTRACTOR), fixes: undefined }
    // Days the stored model covers were stored then, and a rebuild, or a refit of a model of an older shape, leaves
    // them be, as storing them all again would take far more than D1's writes for a day
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
