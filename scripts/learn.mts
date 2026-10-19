// A build step that learns a model through the Worker and writes it for a page to bundle. It never fails the
// build, since menus and the timetable still need deploying: without BUILD_TOKEN or the Worker, the file written
// last stays, or an empty one. Each whole day since the last one learned is folded in, within a budget of the
// build's 20 minutes, and the next build carries on from wherever this one stopped. With --if-missing, a file
// already there is kept; with --rebuild (or MODEL_REBUILD=1), learning starts over from the first day there is.
//
// Learning writes what production has learned, so only a build of the branch production deploys from learns, as
// Cloudflare's builds name it, or a command told to with --store (or NOTUNH_STORE=1); any other, like a preview's
// or a build by hand, bundles what's stored as it is, only reading. So does a build reaching a Worker from before
// models had revisions and checkpoints, as the first build of a version that brings them does, since it runs
// before its Worker deploys: the next build, against the new Worker, learns.
//
// What's being learned and what's published are stored apart: learning carries on from its checkpoint
// ("<name>.training"), stored by every build that learns, and the model is published only once the checkpoint has
// caught up with the one published, so a refit or a rebuild that takes several builds never puts a model through
// fewer days in the place of one through more, and the pages bundle the published model meanwhile, or the
// checkpoint where the published one is of another shape than this build's

import { writeFile } from "node:fs/promises"
import type { URL } from "node:url"
import { type Learned, checkpointOf } from "../src/shared/learn.mts"
import { addDays, type Day } from "../src/shared/time.mts"
import { exists, isKept } from "./files.mts"
import { ApiError, readModel, writeModel } from "./worker.mts"

const PRODUCTION_BRANCH = "main"

export const isRebuild = () =>
  process.argv.includes("--rebuild") || Boolean(process.env.MODEL_REBUILD)

const isStoring = () =>
  process.env.WORKERS_CI_BRANCH === PRODUCTION_BRANCH || process.argv.includes("--store") || Boolean(process.env.NOTUNH_STORE)

const isConflict = (error: unknown) =>
  error instanceof ApiError && error.status === 409

const message = (error: unknown) =>
  error instanceof Error ? error.message : `${error}`

/**
 * Learns the model stored under a name on through the last whole day from its checkpoint, stores the checkpoint if
 * it got further, publishes it once it's caught up, and writes what the page loads to output. Gives back the model
 * bundled, or undefined if the file was kept or the model couldn't be reached
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
    const ofThisShape = (state: M | null | undefined) => state?.version === empty().version ? state : null
    const { state: found, revision, throughs } = await readModel<M>(name)
    // A Worker from before checkpoints has no such name
    const checkpoint = await readModel<M>(checkpointOf(name)).catch(error => error instanceof ApiError && error.status === 404 ? undefined : Promise.reject(error))
    const learning = isStoring() && revision !== undefined && checkpoint?.revision !== undefined
    if (isStoring() && !learning)
      console.warn(`${name}: the Worker predates model revisions or checkpoints, so this build only reads`)
    const published = ofThisShape(found)
    await prepare?.(learning)
    // From where learning left off, else what's published, unless that's of an older shape, which is learned again
    let model = isRebuild() && learning ? empty() : ofThisShape(checkpoint?.state) ?? published ?? empty()
    let folded = 0
    const days = learning ? model.through === null ? await first() : addDays(model.through, 1) : undefined
    for (let day = days; day !== undefined && day <= last; day = addDays(day, 1)) {
      if (Date.now() - started > budgetMs) {
        console.warn(`${name}: ran out of time at ${day}; the next build carries on`)
        break
      }
      // A day that can't be read stops learning there, keeping the days before it, and the next build tries again
      try {
        model = await fold(model, day, throughs.at(-1) ?? null)
        folded++
      }
      catch (error) {
        console.warn(`${name}: stopped at ${day}: ${message(error)}`)
        break
      }
    }
    // Caught up with what's published, of whatever shape, it's published
    const isCaughtUp = model.through !== null && model.through >= (found?.through ?? "")
    let bundled = isCaughtUp ? model : published ?? model
    if (learning && model.through !== null && folded)
      try {
        await writeModel(checkpointOf(name), model, checkpoint!.revision!)
        if (isCaughtUp)
          await writeModel(name, model, revision!)
      }
      catch (error) {
        // Another build learned meanwhile, from the same checkpoint, or published from it, so what's published is
        // bundled, if it's of this shape: one another version of the build stored isn't this one's to bundle
        if (!isConflict(error))
          throw error
        console.warn(`${name}: learned by another build meanwhile, whose model is bundled if it's of this shape`)
        bundled = ofThisShape((await readModel<M>(name)).state) ?? bundled
      }
    await writeFile(output, JSON.stringify(bundle(bundled)))
    console.log(`${name}: ${learning ? "learned" : "as stored, not learning,"} through ${model.through ?? "nothing yet"}${bundled === model ? "" : `, bundling the published model through ${bundled.through}`}`)
    return bundled
  }
  catch (error) {
    console.warn(`${file} not updated: ${message(error)}`)
    if (!await exists(output))
      await writeFile(output, JSON.stringify(bundle(empty())))
  }
}
