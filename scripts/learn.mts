// Learns a model through the Worker and writes it among the inputs a build pins (scripts/inputs.mts), as the Inputs
// workflow does each night. What D1 stores is where learning carries on from, and what's written is what it stores
// once learning's done, so the inputs carry exactly the model the Worker has. That's read by the model's format
// (src/shared/format.mts): one of an older version reads as none, and is learned afresh, and one of a newer version,
// which newer code learned, is left as stored, with an empty one written:
// - with --store, every whole day since the stored model is folded in (from the first day there is, with --rebuild)
//   and stored, compare-and-swap on the revision read. A day that can't be read stops learning there, keeping the
//   days before it, and the next run carries on. A model through fewer days than the one stored, as a rebuild cut
//   short is, isn't stored. Only the Inputs workflow on main stores, since what's stored is what production uses
// - without it, nothing is written to the Worker, and the model stored is written as it is
// - without BUILD_TOKEN, an empty model is written, so the inputs can be made with no Worker to reach
// Learning runs main's code against the Worker main deployed. A Worker that doesn't take a request, as the one before
// a change to the API does, refuses it (worker/api.mts checks every request), and what it stores stays as it was

import type { URL } from "node:url"
import type { Learned } from "../src/shared/learn.mts"
import { type Format, read } from "../src/shared/format.mts"
import { describeIssues } from "../src/shared/json.mts"
import { addDays, type Day } from "../src/shared/time.mts"
import { writeInput } from "./files.mts"
import { readModel, writeModel } from "./worker.mts"

const message = (error: unknown) =>
  error instanceof Error ? error.message : `${error}`

/** Learns the model stored under a name as asked, and writes what the page loads to output, giving back the model */
/**
 * Says learning didn't get as far as it should. The build still goes ahead with what was learned, but the job fails
 * once the rest is published, so a day that never folds is seen rather than freezing the model quietly
 */
const stalled = (reason: string) => {
  console.warn(reason)
  process.exitCode = 1
}

export const learn = async <M extends Learned, B = M>(name: string, output: URL, {
  by, empty, first, last, fold, prepare, bundle = model => model as unknown as B,
  store = process.argv.includes("--store"), rebuild = process.argv.includes("--rebuild")
}: {
  /** How the model stored is read */
  by:       Format<M>,
  empty:    () => M,
  /** What learning needs first, like the timetable it replays new days against acquired */
  prepare?: () => Promise<unknown>,
  /** The first day there's anything to learn from, when nothing's been learned yet */
  first:    () => Promise<Day | undefined>,
  /** The last whole day there is */
  last:     Day,
  /** The model with a day folded in */
  fold:     (model: M, day: Day) => Promise<M>,
  /** What the page loads, when that isn't the model itself */
  bundle?:  (model: M) => B,
  store?:   boolean,
  rebuild?: boolean
}): Promise<M> => {
  let model = empty()
  if (!process.env.BUILD_TOKEN) {
    if (store)
      throw new Error(`${name}: no BUILD_TOKEN to store with`)
    console.warn(`${name}: no BUILD_TOKEN to reach the Worker with, so the model is empty`)
  }
  else {
    const { state, revision } = await readModel<unknown>(name)
    const stored = read(by, state)
    if ("newer" in stored)
      (store ? stalled : console.warn)(`${name}: the model stored is of version ${stored.newer}, newer than this learns, so it's left as it is, and the model here is empty`)
    else {
      if ("value" in stored)
        model = stored.value
      else if (state !== null)
        console.warn(`${name}: the model stored isn't read (${describeIssues(stored.issues)}), so it's learned afresh`)
      if (store) {
        let learned = rebuild ? empty() : model
        let day: Day | undefined
        try {
          await prepare?.()
          for (day = learned.through === null ? await first() : addDays(learned.through, 1); day !== undefined && day <= last; day = addDays(day, 1))
            learned = await fold(learned, day)
        }
        catch (error) {
          stalled(`${name}: stopped${day ? ` at ${day}` : ""}, which the next run carries on from: ${message(error)}`)
        }
        if (learned !== model && learned.through !== null && learned.through >= (model.through ?? ""))
          await writeModel(name, learned, revision).catch(error => stalled(`${name}: not stored: ${message(error)}`))
        const kept = read(by, (await readModel<unknown>(name)).state)
        model = "value" in kept ? kept.value : empty()
      }
    }
  }
  await writeInput(output, JSON.stringify(bundle(model)))
  console.log(`${name}: through ${model.through ?? "nothing yet"}`)
  return model
}
