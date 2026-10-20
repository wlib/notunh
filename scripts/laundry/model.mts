// Learns when each laundry room usually has a machine free, through scripts/learn.mts. Folds in each whole day since
// the last model from the collector's transitions and polls, and writes src/laundry/usual.json among the inputs for
// the page to load as a hashed asset, for every machine in the collector's inventory, without which nothing's written.
// --store learns and stores, and --local uses `wrangler dev`

import { addDays, localDay } from "../../src/shared/time.mts"
import type { Known, Poll, Transition } from "../../src/laundry/infer.mts"
import { bundle, emptyLearned, update } from "../../src/laundry/model.mts"
import { learn } from "../learn.mts"
import { STAGED } from "../files.mts"
import { health, readRows } from "../worker.mts"

const machines = process.env.BUILD_TOKEN ? await readRows<Known>("machines") : []
if (process.env.BUILD_TOKEN && !machines.length)
  throw new Error("No machine inventory to learn or bundle laundry's model for")

const learned = await learn("laundry", new URL("src/laundry/usual.json", STAGED), {
  empty: emptyLearned,
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
console.log(`Laundry: ${Object.keys(learned.stats).length} rooms`)
