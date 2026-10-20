// The build's data, in two stages the build runs apart, with its typecheck and tests between them, so nothing is
// written to the Worker until they pass:
//
//   node scripts/data.mts fetch [--if-missing]   the timetable, style, menus, rooms, map data, and places, read only
//   node scripts/data.mts learn [--if-missing]   the bus and laundry models, as stored, or with --store, learned
//                                                on and stored in D1, as main's build does (scripts/learn.mts)
//
// and with neither, both. With NOTUNH_OFFLINE set, as pull requests are checked, nothing upstream is asked. Every
// file comes from the fixtures (tests/fixtures/data/), the places are still matched from them, and nothing is
// learned. With --if-missing each step keeps its own file, the places only while their inputs are unchanged.
// `npm run dev` only fetches. Only main's build or --store learns, since learning writes what production uses

import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import { FIXTURES, fromFixtures, isOffline } from "./files.mts"

const STAGES = {
  fetch: ["map/gtfs", "map/style", "dining/menus", "laundry/rooms", "map/osm", "map/places"],
  learn: ["map/model", "laundry/model"]
}

const args = process.argv.slice(2)
const flags = args.filter(arg => arg.startsWith("--"))
const stages = (Object.keys(STAGES) as (keyof typeof STAGES)[]).filter(stage => args.includes(stage) || !args.some(arg => arg in STAGES))

const step = (name: string) =>
  new Promise<void>((done, reject) =>
    spawn(process.execPath, [new URL(`${name}.mts`, import.meta.url).pathname, ...flags], { stdio: "inherit" })
      .on("error", reject)
      .on("exit", code => code === 0 ? done() : reject(new Error(`${name} exited with ${code}`)))
  )

if (isOffline) {
  if (stages.includes("fetch")) {
    for (const path of await readdir(FIXTURES))
      await fromFixtures(path)
    console.log(`Data from the fixtures, offline`)
    await step("map/places")
  }
}
else
  for (const stage of stages)
    for (const name of STAGES[stage])
      await step(name)
