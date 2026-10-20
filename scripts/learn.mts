// Learns a model through the Worker and writes it among the inputs a build pins (scripts/inputs.mts), as the Inputs
// workflow does each night. What D1 stores is where learning carries on from, and what's written is what it stores
// once learning's done, so the inputs carry exactly the model the Worker has, or an empty one while it has another
// version's:
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
import { addDays, type Day } from "../src/shared/time.mts"
import { writeInput } from "./files.mts"
import { readModel, writeModel } from "./worker.mts"

const message = (error: unknown) =>
  error instanceof Error ? error.message : `${error}`

/** Learns the model stored under a name as asked, and writes what the page loads to output, giving back the model */
export const learn = async <M extends Learned, B = M>(name: string, output: URL, {
  empty, first, last, fold, prepare, bundle = model => model as unknown as B,
  store = process.argv.includes("--store"), rebuild = process.argv.includes("--rebuild")
}: {
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
  const ofThisShape = (state: M | null) => state?.version === empty().version ? state : null
  let model = empty()
  if (!process.env.BUILD_TOKEN) {
    if (store)
      throw new Error(`${name}: no BUILD_TOKEN to store with`)
    console.warn(`${name}: no BUILD_TOKEN to reach the Worker with, so the model is empty`)
  }
  else {
    const { state, revision } = await readModel<M>(name)
    model = ofThisShape(state) ?? model
    if (store) {
      let learned = rebuild ? empty() : model
      let day: Day | undefined
      try {
        await prepare?.()
        for (day = learned.through === null ? await first() : addDays(learned.through, 1); day !== undefined && day <= last; day = addDays(day, 1))
          learned = await fold(learned, day)
      }
      catch (error) {
        console.warn(`${name}: stopped${day ? ` at ${day}` : ""}, which the next run carries on from: ${message(error)}`)
      }
      if (learned !== model && learned.through !== null && learned.through >= (model.through ?? ""))
        await writeModel(name, learned, revision).catch(error => console.warn(`${name}: not stored: ${message(error)}`))
      model = ofThisShape((await readModel<M>(name)).state) ?? empty()
    }
  }
  await writeInput(output, JSON.stringify(bundle(model)))
  console.log(`${name}: through ${model.through ?? "nothing yet"}`)
  return model
}
