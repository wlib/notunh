// The build's data, in two stages that the build runs apart, with its typecheck and tests between them, so nothing
// is written anywhere but here until they pass:
//
//   node scripts/data.mts fetch [--if-missing]   the timetable, style, menus, rooms, map data, and places, read only
//   node scripts/data.mts learn [--if-missing]   the bus and laundry models, which store what they learn in D1
//
// and with neither, both. With NOTUNH_OFFLINE set, as pull requests are checked, nothing upstream is asked: every
// file comes from the fixtures (tests/fixtures/data/), the places are still matched from them, and nothing is
// learned. Each step keeps its own file with --if-missing

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
