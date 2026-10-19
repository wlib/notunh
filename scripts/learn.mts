// A build step that learns a model through the Worker and writes it for a page to bundle. It never fails the
// build, since menus and the timetable still need deploying: without BUILD_TOKEN or the Worker, the file written
// last stays, or an empty one. Each whole day since the last one learned is folded in, within a budget of the
// build's 20 minutes, and the next build carries on from wherever this one stopped. With --if-missing, a file
// already there is kept; with --rebuild (or MODEL_REBUILD=1), learning starts over from the first day there is.
//
// Learning writes what production has learned, so only a build of the branch production deploys from learns, as
// Cloudflare's builds name it, or a command run by hand; any other, like a preview's, bundles what's stored as it
// is, only reading. So does a build reaching a Worker from before models had revisions, as the first build of this
// version does, since it runs before its Worker deploys: the next build, against the new Worker, learns

import { writeFile } from "node:fs/promises"
import type { URL } from "node:url"
import type { Learned } from "../src/shared/learn.mts"
import { addDays, type Day } from "../src/shared/time.mts"
import { exists, isKept } from "./files.mts"
import { ApiError, readModel, writeModel } from "./worker.mts"

const PRODUCTION_BRANCH = "main"

export const isRebuild = process.argv.includes("--rebuild") || Boolean(process.env.MODEL_REBUILD)
export const isLearning = (process.env.WORKERS_CI_BRANCH ?? PRODUCTION_BRANCH) === PRODUCTION_BRANCH

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
  /** Required inputs fetched within the same failure boundary as the model, whether learning or only reading it */
  prepare?:  (isLearning: boolean) => Promise<void>,
  /** The first day there's anything to learn from, when nothing's been learned yet */
  first:     () => Promise<Day | undefined>,
  /** The last whole day there is */
  last:      Day,
  /**
   * The model with a day folded in, given the last day any model stored before the build ran through, of whatever
   * shape, for what it may skip
   */
  fold:      (model: M, day: Day, storedThrough: Day | null) => Promise<M>,
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
    const { state: found, revision, throughs } = await readModel<M>(name)
    const learning = isLearning && revision !== undefined
    if (isLearning && !learning)
      console.warn(`${name}: the Worker predates model revisions, so this build only reads`)
    // A model of an older shape is learned again from the start, carrying on from where a refit stopped
    const ofThisShape = (state: M | null) => state?.version === empty().version ? state : null
    const stored = ofThisShape(found)
    await prepare?.(learning)
    let model = isRebuild && learning ? empty() : stored ?? empty()
    const days = learning ? model.through === null ? await first() : addDays(model.through, 1) : undefined
    for (let day = days; day !== undefined && day <= last; day = addDays(day, 1)) {
      if (Date.now() - started > budgetMs) {
        console.warn(`${name}: ran out of time at ${day}; the next build carries on`)
        break
      }
      // A day that can't be read stops learning there, keeping the days before it, and the next build tries again
      try {
        model = await fold(model, day, throughs.at(-1) ?? null)
      }
      catch (error) {
        console.warn(`${name}: stopped at ${day}: ${message(error)}`)
        break
      }
    }
    if (learning && model.through !== null && (isRebuild || model.through > (stored?.through ?? "")))
      try {
        await writeModel(name, model, revision!)
      }
      catch (error) {
        // Another build stored a model meanwhile, which went on from the same one, so its model is the one kept and
        // bundled, if it's of this shape: one another version of the build stored isn't this one's to bundle
        if (!(error instanceof ApiError && error.status === 409))
          throw error
        console.warn(`${name}: stored by another build meanwhile, whose model is bundled if it's of this shape`)
        model = ofThisShape((await readModel<M>(name)).state) ?? model
      }
    await writeFile(output, JSON.stringify(bundle(model)))
    console.log(`${name}: ${learning ? "learned" : "as stored, not learning,"} through ${model.through ?? "nothing yet"}`)
    return model
  }
  catch (error) {
    console.warn(`${file} not updated: ${message(error)}`)
    if (!await exists(output))
      await writeFile(output, JSON.stringify(bundle(empty())))
  }
}
