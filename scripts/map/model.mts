// Learns the bus model in the build, as scripts/learn.mts does, and writes src/map/model.json for the map to
// bundle. Each whole service day is folded in from the visits its samples show while the Worker keeps them, which
// are stored, as they outlast the samples, or else from the visits stored then, with how forecasts did that day
// scored. With --rebuild (or MODEL_REBUILD=1), the model is learned afresh from every visit still stored, extracted
// again where the samples are still kept; --local uses `wrangler dev`

import { readFile } from "node:fs/promises"
import { serviceDayStart, withIndexes } from "../../src/map/feed.mts"
import type { Visit } from "../../src/map/events.mts"
import { emptyModel, update } from "../../src/map/model.mts"
import { type Day, addDays, localDay } from "../../src/shared/time.mts"
import { isRebuild, learn } from "../learn.mts"
import { health, readRows, writeRows } from "../worker.mts"
import { FEED, describe, extractDay, score } from "./replay.mts"

const OUTPUT = new URL("../../src/map/model.json", import.meta.url)
// Samples still arrive this long after a service day ends
const SETTLE_MS = 15 * 60_000

const feed = withIndexes(JSON.parse(await readFile(FEED, "utf8")))
const today = localDay(Date.now())

// The first days the Worker has samples and visits for, asked once there's a day to learn
let firsts: Promise<{ sampled?: Day, stored?: Day }> | undefined
const firstDays = () =>
  firsts ??= health().then(({ buses, visits }) => ({
    sampled: buses.since === null ? undefined : localDay(buses.since),
    stored:  visits.since === null ? undefined : localDay(visits.since * 1000)
  }))

const model = await learn("buses", OUTPUT, {
  empty: emptyModel,
  first: async () => {
    const { sampled, stored } = await firstDays()
    return [sampled, isRebuild ? stored : undefined].filter(day => day !== undefined).sort()[0]
  },
  last:  addDays(today, serviceDayStart(today) + SETTLE_MS <= Date.now() ? -1 : -2),
  fold:  async (model, day, stored) => {
    const { sampled } = await firstDays()
    const isSampled = sampled !== undefined && day >= sampled
    const visits = isSampled ? await extractDay(feed, day) : await readRows<Visit>("visits", day)
    // Days the stored model covers were stored then, and a rebuild leaves them be, as storing them all again would
    // take far more than D1's writes for a day
    if (isSampled && day > (stored?.through ?? ""))
      await writeRows("visits", visits, day)
    console.log(`buses: ${day}, ${visits.length} visits`)
    return update(model, day, visits, score(model, feed, visits))
  },
  // Of the build's 20 minutes, what fitting can take
  budgetMs: 8 * 60_000
})

if (model)
  console.log(describe(model.scores))
