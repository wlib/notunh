// Learns when each laundry room usually has a machine free in the build: folds each whole day since the last model
// from the collector's transitions and runs, and writes src/laundry/usual.json for the page to load as a hashed
// asset. Everything goes through the Worker with BUILD_TOKEN and never fails the build (see scripts/learn.mts);
// --local uses `wrangler dev`

import { addDays, localDay } from "../../src/shared/time.mts"
import type { Known, Poll, Transition } from "../../src/laundry/infer.mts"
import { bundle, emptyLearned, update } from "../../src/laundry/model.mts"
import { learn } from "../learn.mts"
import { health, readRows } from "../worker.mts"

const OUTPUT = new URL("../../src/laundry/usual.json", import.meta.url)

let machines: Known[] = []

const learned = await learn("laundry", OUTPUT, {
  empty: emptyLearned,
  prepare: async () => {
    machines = await readRows<Known>("machines")
    if (!machines.length)
      throw new Error("No machine inventory; keeping the previous laundry model")
  },
  first: async () => {
    const { transitions: { since } } = await health()
    return since === null ? undefined : localDay(since)
  },
  last:  addDays(localDay(Date.now()), -1),
  fold:  async (learned, day) => {
    const [transitions, polls] = await Promise.all([readRows<Transition>("transitions", day), readRows<Poll>("polls", day)])
    // Pages come in the order they were stored, and one run's transitions can be stamped out of order
    return update(learned, machines, day, transitions.sort((a, b) => a.at - b.at), polls.sort((a, b) => a.at - b.at))
  },
  bundle: learned => bundle(learned, machines)
})
if (learned)
  console.log(`Laundry: ${Object.keys(learned.stats).length} rooms`)
