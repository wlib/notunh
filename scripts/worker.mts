// How build steps reach the Worker: through its token-gated /api/ routes, so the build needs no D1 credentials of
// its own, only BUILD_TOKEN. The origin is notunh.app, or WORKER_ORIGIN, or with --local, `wrangler dev` on
// localhost:8787, which checks against the BUILD_TOKEN in .dev.vars (site.mts). Run directly to look:
// BUILD_TOKEN=… node scripts/worker.mts health | storage | rows <name> [day] [--local]

import type { Day } from "../src/shared/time.mts"
import { gunzipJson, gzipJson } from "../src/shared/json.mts"
import { fromHex } from "../src/transit/observations/raw.mts"
import { ORIGIN } from "./site.mts"

/**
 * The version of the API the Worker serves, which a Worker from before versions doesn't say, when each table's rows
 * start and end, in its own unit, and the last day each model has learned through
 */
export type Health = {
  api?:   number
} & {
  [name in "buses" | "predictions" | "transitions" | "polls"]: { since: number | null, last: number | null }
} & {
  models: Record<string, Day | null>
}

/** How big the database is: bytes, and rows of each table */
export type Storage = { bytes: number, rows: Record<string, number> }

// A request taking longer has stalled
const TIMEOUT_MS = 30_000
// Bytes in a part of a generation, half the 2 MB D1 keeps a row to
const PART = 1 << 20

/** What the Worker answered a request with, when that wasn't success */
export class ApiError extends Error {
  readonly status: number
  constructor(path: string, status: number) {
    super(`${path} ${status}`)
    this.status = status
  }
}

/**
 * A /api/ route's JSON, or nothing for most writes. A body given is sent: bytes PUT, a form POSTed, and anything else
 * POSTed as JSON
 */
export const request = async <T,>(path: string, body?: unknown): Promise<T> => {
  const isJson = body !== undefined && !(body instanceof Uint8Array || body instanceof FormData)
  const response = await fetch(ORIGIN + path, {
    method:  body === undefined ? "GET" : body instanceof Uint8Array ? "PUT" : "POST",
    headers: { authorization: `Bearer ${process.env.BUILD_TOKEN}`, ...isJson && { "content-type": "application/json" } },
    body:    isJson ? JSON.stringify(body) : body as BodyInit | undefined,
    signal:  AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok)
    throw new ApiError(path, response.status)
  return response.status === 204 ? undefined as T : response.json()
}

/** A table's rows, those of one day for a table that has days, in the order they were stored, without null fields */
export const readRows = async <T,>(name: string, day?: Day): Promise<T[]> => {
  const rows: T[] = []
  for (let after: number | null = 0; after !== null;) {
    const page: { rows: Record<string, unknown>[], next: number | null } =
      await request(`/api/rows/${name}?${new URLSearchParams({ ...day && { day }, after: `${after}` })}`)
    rows.push(...page.rows.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as T))
    after = page.next
  }
  return rows
}

/**
 * What's derived from a day by a name (worker/derived.mts): as published, if it was derived from exactly this, else
 * made now and published, its generation's parts first and then the manifest committing them
 */
export const derived = async <T,>(name: string, day: Day, from: object, make: () => Promise<T>): Promise<T> => {
  const identity = JSON.stringify(from)
  const found = await request<{ identity: string, parts: string[] } | null>(`/api/derived/${name}?day=${day}`)
  if (found?.identity === identity)
    return await gunzipJson(...found.parts.map(fromHex)) as T
  const value = await make()
  const body = await gzipJson(value)
  const generation = crypto.randomUUID()
  const parts = Math.max(1, Math.ceil(body.length / PART))
  for (let part = 0; part < parts; part++)
    await request(`/api/chunks/${generation}/${part}`, body.subarray(part * PART, (part + 1) * PART))
  await request(`/api/derived/${name}`, { day, identity, generation, parts })
  return value
}

/** The latest state stored under a name, null if there's none, with its revision, null too if there's none */
export const readModel = <M,>(name: string) =>
  request<{ state: M | null, revision: string | null }>(`/api/models/${name}`)

/** Stores a state, if the latest stored is still the revision read, or null for none, else fails with a 409 */
export const writeModel = (name: string, state: unknown, expect: string | null) =>
  request<void>(`/api/models/${name}`, { expect, state })

export const health = () =>
  request<Health>("/api/health")

export const storage = () =>
  request<Storage>("/api/storage")

if (import.meta.main) {
  const [command, name = "", day] = process.argv.slice(2).filter(arg => !arg.startsWith("--"))
  if (command === "rows") {
    const rows = await readRows<{ at?: number }>(name, day)
    const ats = rows.flatMap(({ at }) => at === undefined ? [] : [at])
    console.log(`${name}${day ? ` ${day}` : ""}: ${rows.length} rows` + (ats.length ? `, at ${Math.min(...ats)} to ${Math.max(...ats)}` : ""))
  }
  else
    console.log(JSON.stringify(await (command === "storage" ? storage() : health()), null, 2))
}
