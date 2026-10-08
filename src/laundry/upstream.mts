// The laundry machines' live status, from LaundryConnect Live (laundryconnectlive.com), the web app for the rooms'
// Speed Queen machines. It has no CORS, so only the Worker and the build ask it, and only the Worker per room

import { getJson } from "../shared/json.mts"
import { statusOf, type Machine } from "./infer.mts"

const BASE = "https://laundryconnectlive.com/api/alliance"

// What every UNH room's name starts with
const PREFIX = "University of New Hampshire"

/** The slice of the vendor's machine we read */
export type UpstreamMachine = {
  id:            string,
  machineNumber: string,
  modelNumber:   string,
  /** Like "Topload Washer" or "Stack Dryer Upper", which is the only word on which of a stack it is */
  machineType:   { name?: string, isWasher: boolean, isDryer: boolean },
  status: {
    statusId:         string,
    receivedAt:       string,
    remainingSeconds: number,
    selectedCycle?:   { name: string } | null
  }
}

export type Room = { id: string, name: string }

const get = <T,>(path: string, signal?: AbortSignal, headers?: HeadersInit) =>
  getJson<T>(BASE + path, { signal, headers })

const isUsable = (m: any): m is UpstreamMachine =>
  typeof m?.id === "string" && typeof m.machineNumber === "string" && typeof m.modelNumber === "string" &&
  typeof m.machineType?.isDryer === "boolean" && typeof m.status?.statusId === "string" &&
  Number.isFinite(Date.parse(m.status.receivedAt)) && Number.isFinite(m.status.remainingSeconds)

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

/** A room's machines, leaving out any the vendor sends in a shape we don't know, so a change upstream shows less rather than garbage */
export const parseMachines = (room: string, body: { data?: unknown }) =>
  (Array.isArray(body?.data) ? body.data : []).filter(isUsable).map(m => normalize(room, m))

export const fetchMachines = async (room: string, signal?: AbortSignal, headers?: HeadersInit) =>
  parseMachines(room, await get(`/locations/${encodeURIComponent(room)}/machines`, signal, headers))

/** Like "Stoke Hall G05" for "University of New Hampshire - Stoke Hall G05", and "Hetzel 3rd Floor" for its "Hetzel - 3rd Floor" */
const shortName = (name: string) =>
  name.replace(new RegExp(`^${PREFIX}\\s*-\\s*`), "").replace(/\s+-\s+/g, " ").trim()

/** Every UNH room, by its short name */
export const fetchRooms = async (signal?: AbortSignal): Promise<Room[]> => {
  const { data } = await get<{ data?: Room[] }>(`/locations?${new URLSearchParams({ namePrefix: PREFIX, limit: "100" })}`, signal)
  return (data ?? []).map(({ id, name }) => ({ id, name: shortName(name) }))
}
