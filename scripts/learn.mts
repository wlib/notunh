// A build step that learns a model through the Worker and writes it for a page to bundle. It never fails the
// build, since menus and the timetable still need deploying: without BUILD_TOKEN or the Worker, the file written
// last stays, or an empty one. Each whole day since the last one learned is folded in, within a budget of the
// build's 20 minutes, and the next build carries on from wherever this one stopped. With --if-missing, a file
// already there is kept; with --rebuild (or MODEL_REBUILD=1), learning starts over from the first day there is

import { writeFile } from "node:fs/promises"
import type { Learned } from "../src/shared/learn.mts"
import { addDays, type Day } from "../src/shared/time.mts"
import { exists, isKept } from "./files.mts"
import { readModel, writeModel } from "./worker.mts"

export const isRebuild = process.argv.includes("--rebuild") || Boolean(process.env.MODEL_REBUILD)

const message = (error: unknown) =>
  error instanceof Error ? error.message : `${error}`

/**
 * Learns the model stored under a name on through the last whole day, stores it if that's further than before (or
 * at all, on a rebuild), and writes what the page loads to output. Gives back the model, or undefined if the file
 * was kept or the model couldn't be reached
 */
export const learn = async <M extends Learned, B = M>(name: string, output: URL, {
  empty, first, last, fold, prepare, bundle = model => model as unknown as B, budgetMs = 3 * 60_000
}: {
  empty:     () => M,
  /** Required inputs fetched within the same failure boundary as the model */
  prepare?:  () => Promise<void>,
  /** The first day there's anything to learn from, when nothing's been learned yet */
  first:     () => Promise<Day | undefined>,
  /** The last whole day there is */
  last:      Day,
  /** The model with a day folded in, given what was stored before the build for what it may skip */
  fold:      (model: M, day: Day, stored: M | null) => Promise<M>,
  /** What the page loads, when that isn't the model itself */
  bundle?:   (model: M) => B,
  budgetMs?: number
}): Promise<M | undefined> => {
  if (await isKept(output))
    return
  const file = output.pathname.split("/").at(-1)
  try {
    if (!process.env.BUILD_TOKEN)
      throw new Error("no BUILD_TOKEN to reach the Worker with")
    const started = Date.now()
    const found = await readModel<M>(name)
    // A model of an older shape is learned again from the start
    const stored = found?.version === empty().version ? found : null
    await prepare?.()
    let model = isRebuild ? empty() : stored ?? empty()
    for (let day = model.through === null ? await first() : addDays(model.through, 1); day !== undefined && day <= last; day = addDays(day, 1)) {
      if (Date.now() - started > budgetMs) {
        console.warn(`${name}: ran out of time at ${day}; the next build carries on`)
        break
      }
      // A day that can't be read stops learning there, keeping the days before it, and the next build tries again
      try {
        model = await fold(model, day, stored)
      }
      catch (error) {
        console.warn(`${name}: stopped at ${day}: ${message(error)}`)
        break
      }
    }
    if (model.through !== null && (isRebuild || model.through > (stored?.through ?? "")))
      await writeModel(name, model)
    await writeFile(output, JSON.stringify(bundle(model)))
    console.log(`${name}: learned through ${model.through ?? "nothing yet"}`)
    return model
  }
  catch (error) {
    console.warn(`${file} not updated: ${message(error)}`)
    if (!await exists(output))
      await writeFile(output, JSON.stringify(bundle(empty())))
  }
}
