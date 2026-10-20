// The laundry machines' live status, from LaundryConnect Live (laundryconnectlive.com), the web app for the rooms'
// Speed Queen machines. It sends no CORS headers, so only the Worker and the build scripts ask it. Pages go through
// the Worker, which forwards the asker's own User-Agent (worker/laundry.mts)

import * as v from "valibot"
import { getJson, usable } from "../shared/json.mts"
import { statusOf, type Machine } from "./infer.mts"

const BASE = "https://laundryconnectlive.com/api/alliance"

// What every UNH room's name starts with
const PREFIX = "University of New Hampshire"

/** The slice of the vendor's machine we read */
const UpstreamMachine = v.object({
  id:            v.string(),
  machineNumber: v.string(),
  modelNumber:   v.string(),
  machineType:   v.object({
    /** Like "Topload Washer" or "Stack Dryer Upper", which is the only word on which of a stack it is */
    name:    v.optional(v.string()),
    isDryer: v.boolean()
  }),
  status: v.object({
    statusId:         v.string(),
    receivedAt:       v.pipe(v.string(), v.check(at => Number.isFinite(Date.parse(at)))),
    remainingSeconds: v.number(),
    selectedCycle:    v.nullish(v.object({ name: v.string() }))
  })
})
export type UpstreamMachine = v.InferOutput<typeof UpstreamMachine>

export const Room = v.object({ id: v.string(), name: v.string() })
export type Room = v.InferOutput<typeof Room>

const get = <T,>(path: string, schema: v.GenericSchema<unknown, T>, signal?: AbortSignal, headers?: HeadersInit) =>
  getJson(BASE + path, { schema, signal, headers })

const stackOf = (name = "") =>
  /\bupper\b/i.test(name) ? "upper" : /\blower\b/i.test(name) ? "lower" : undefined

export const normalize = (room: string, m: UpstreamMachine): Machine => ({
  id:        m.id,
  room,
  number:    m.machineNumber.replace(/^0+(?=.)/, ""),
  kind:      m.machineType.isDryer ? "dryer" : "washer",
  model:     m.modelNumber.trim(),
  stack:     stackOf(m.machineType.name),
  status:    statusOf(m.status.statusId),
  raw:       m.status.statusId,
  at:        Date.parse(m.status.receivedAt),
  remaining: m.status.remainingSeconds,
  cycle:     m.status.selectedCycle?.name ?? undefined
})

/** A room's machines as the vendor answers for them, leaving out any in a shape we don't know */
export const machinesIn = (room: string) =>
  v.pipe(
    v.object({ data: v.optional(usable(UpstreamMachine), []) }),
    v.transform(({ data }) => data.map(m => normalize(room, m)))
  )

export const fetchMachines = (room: string, signal?: AbortSignal, headers?: HeadersInit) =>
  get(`/locations/${encodeURIComponent(room)}/machines`, machinesIn(room), signal, headers)

/** Like "Stoke Hall G05" for "University of New Hampshire - Stoke Hall G05", and "Hetzel 3rd Floor" for its "Hetzel - 3rd Floor" */
const shortName = (name: string) =>
  name.replace(new RegExp(`^${PREFIX}\\s*-\\s*`), "").replace(/\s+-\s+/g, " ").trim()

/** Every UNH room, by its short name */
export const fetchRooms = async (signal?: AbortSignal): Promise<Room[]> => {
  const { data } = await get(`/locations?${new URLSearchParams({ namePrefix: PREFIX, limit: "100" })}`, v.object({ data: v.optional(v.array(Room), []) }), signal)
  return data.map(({ id, name }) => ({ id, name: shortName(name) }))
}
