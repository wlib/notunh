// Makes the inputs a build pins (scripts/inputs.mts) in inputs/, laid out as the repository is, as the Inputs
// workflow does each night (.github/workflows/inputs.yml):
//
//   node scripts/data.mts acquire    the timetable, style, menus, and laundry rooms, from upstream
//   node scripts/data.mts learn      the bus and laundry models, through the Worker (scripts/learn.mts), with
//                                    --store to learn and store, --rebuild, and --local
//
// and with neither, both, and then the site built from them (`npm run fresh`), so the whole sequence runs locally.
// Acquiring starts inputs/ afresh

import { rm } from "node:fs/promises"
import { STAGED, run } from "./files.mts"

const STAGES = {
  acquire: ["map/gtfs", "map/style", "dining/menus", "laundry/rooms"],
  learn:   ["map/model", "laundry/model"]
}

const args = process.argv.slice(2)
const flags = args.filter(arg => arg.startsWith("--"))
const isWhole = !args.some(arg => arg in STAGES)

for (const stage of Object.keys(STAGES) as (keyof typeof STAGES)[])
  if (isWhole || args.includes(stage)) {
    if (stage === "acquire")
      await rm(STAGED, { recursive: true, force: true })
    for (const name of STAGES[stage])
      await run(process.execPath, [new URL(`${name}.mts`, import.meta.url).pathname, ...flags])
  }

if (isWhole)
  await run("npm", ["run", "build"], { env: { ...process.env, NOTUNH_INPUTS: "./inputs" } })
