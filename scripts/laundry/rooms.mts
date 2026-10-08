// Lists UNH's laundry rooms from LaundryConnect into src/laundry/rooms.json, which the page bundles and the Worker
// polls. Rooms rarely change, but the site rebuilds nightly, so a new or renamed one shows up the next morning.
// With --if-missing, rooms already there are kept

import { writeFile } from "node:fs/promises"
import { fetchRooms } from "../../src/laundry/upstream.mts"
import { isKept } from "../files.mts"

const OUT = new URL("../../src/laundry/rooms.json", import.meta.url)

if (await isKept(OUT))
  process.exit(0)

const rooms = (await fetchRooms())
  .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
if (!rooms.length)
  throw new Error("LaundryConnect listed no rooms")

await writeFile(OUT, JSON.stringify(rooms, null, 2) + "\n")
console.log(`${rooms.length} laundry rooms`)
