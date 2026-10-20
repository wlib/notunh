// Lists UNH's laundry rooms from LaundryConnect into src/laundry/rooms.json, which the page bundles and the Worker
// polls. Rooms rarely change, but the inputs are made nightly (scripts/data.mts), so a new or renamed one shows up the
// next morning

import { fetchRooms } from "../../src/laundry/upstream.mts"
import { writeInput } from "../files.mts"

const rooms = (await fetchRooms())
  .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
if (!rooms.length)
  throw new Error("LaundryConnect listed no rooms")

await writeInput("src/laundry/rooms.json", JSON.stringify(rooms, null, 2) + "\n")
console.log(`${rooms.length} laundry rooms`)
