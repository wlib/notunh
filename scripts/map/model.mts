// Learns the bus model in the build through scripts/learn.mts, and writes src/map/model.json for the map to bundle.
// Each whole service day is folded in from what's derived from its observations, read from the day's archive or the
// Worker while it keeps them (scripts/observations.mts), against the timetable in effect then (replay.mts), of those
// the build has acquired. This build's own is acquired first. What's derived is published to the Worker, each by
// exactly what it was derived from, and reused for that alone (worker/derived.mts):
// - visits: what the extractor reads of the observations, with the timetable
// - statistics: what the visits show (fit.mts summarize), which the model folds
// - evaluation: how the model as it stood before the day forecast it, scored by replaying the day (replay.mts score),
//   which calibrates its bands while the predictor stays the same
// With --rebuild (or MODEL_REBUILD=1), the model is learned afresh from the first day observed. --local uses
// `wrangler dev`

import { fetchCatalog } from "../../src/transit/observations/archive.mts"
import { EXTRACTOR, type Visit } from "../../src/transit/inference/events.mts"
import { emptyModel, type Evaluation } from "../../src/transit/models/model.mts"
import { fold, summarize } from "../../src/transit/models/fit.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { localDay } from "../../src/shared/time.mts"
import { lastSettled, observationsOf } from "../observations.mts"
import { learn } from "../learn.mts"
import { derived, health } from "../worker.mts"
import { PREDICTOR, acquireFeed, describe, feedFor, listeningOf, score, visitsOf } from "./replay.mts"

const OUTPUT = new URL("../../src/map/model.json", import.meta.url)

const model = await learn("buses", OUTPUT, {
  empty:   emptyModel,
  // Only a build that learns acquires its timetable
  prepare: async learning => {
    if (learning && await acquireFeed())
      console.log("buses: acquired the timetable")
  },
  // The first day archived or with samples in the Worker
  first: async () => {
    const [{ buses }, { days }] = await Promise.all([health(), fetchCatalog()])
    return [days[0]?.day, buses.since === null ? undefined : localDay(buses.since)].filter(day => day !== undefined).sort()[0]
  },
  last:  lastSettled(Date.now()),
  fold:  async (model, day) => {
    const timetable = await feedFor(day)
    // A day no timetable acquired says it ran by can't be replayed, so it's folded in as though nothing was seen
    if (!timetable) {
      console.warn(`buses: ${day}, no timetable acquired is in effect then, so it's left out`)
      return fold(model, day, summarize([]))
    }
    const { id: feed, isLater } = timetable
    if (isLater)
      console.warn(`buses: ${day}, against a timetable acquired after it`)
    const observed = await observationsOf(day)
    const isListening = listeningOf(observed)
    const inputs = { observations: observed.id, feed, extractor: EXTRACTOR }
    let visits: Visit[] | undefined
    const visited = async () =>
      visits ??= await derived("visits", day, inputs, async () => visitsOf(timetable.feed, observed))
    const statistics = await derived("statistics", day, { ...inputs, version: model.version }, async () =>
      summarize(await visited(), isListening)
    )
    const predictor = { ...inputs, predictor: PREDICTOR, model: await contentHash(JSON.stringify(model)) }
    const evaluation = await derived("evaluation", day, predictor, async (): Promise<Evaluation> =>
      ({ predictor: PREDICTOR, scores: score(model, timetable.feed, await visited(), observed.fixes, isListening) })
    )
    console.log(`buses: ${day}, ${observed.fixes.length} fixes`)
    return fold(model, day, statistics, evaluation)
  },
  // Of the build's 20 minutes, what fitting can take
  budgetMs: 8 * 60_000
})

if (model)
  console.log(describe(model.scores))
