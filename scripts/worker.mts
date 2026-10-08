// How build steps reach the Worker: through its token-gated /api/ routes, so the build needs no D1 credentials of
// its own, only BUILD_TOKEN. With --local, from `wrangler dev` on localhost:8787, which takes the BUILD_TOKEN in
// .dev.vars; otherwise from WORKER_ORIGIN, or notunh.app. Run directly to look:
// BUILD_TOKEN=… node scripts/worker.mts health | rows <name> [day] [--local]

import type { Day } from "../src/shared/time.mts"

/** When each table's rows start and end, in its own unit, and the last day each model has learned through */
export type Health = {
  [name in "buses" | "predictions" | "visits" | "transitions" | "polls"]: { since: number | null, last: number | null }
} & {
  models: Record<string, Day | null>
}

const ORIGIN = process.argv.includes("--local") ? "http://localhost:8787" : process.env.WORKER_ORIGIN ?? "https://notunh.app"
// A request taking longer has stalled
const TIMEOUT_MS = 30_000
// Rows a POST carries, within what the Worker takes in one
const ROWS_PER_REQUEST = 200

/** A /api/ route's JSON, or with a body, what it says to a POST of it, which is nothing for most */
export const request = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(ORIGIN + path, {
    method:  body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.BUILD_TOKEN}`, "content-type": "application/json" },
    body:    body === undefined ? undefined : JSON.stringify(body),
    signal:  AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok)
    throw new Error(`${path} ${response.status}`)
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
 * Stores rows a request at a time, clearing a day's rows first if asked, so a day can be stored again in place, even
 * with nothing
 */
export const writeRows = async (name: string, rows: readonly unknown[], clear?: Day) => {
  for (let i = 0; i < rows.length || i === 0 && clear !== undefined; i += ROWS_PER_REQUEST)
    await request(`/api/rows/${name}`, { rows: rows.slice(i, i + ROWS_PER_REQUEST), ...i === 0 && clear && { clear } })
}

/** The model last stored under a name, or null if there's none */
export const readModel = <M,>(name: string) =>
  request<{ state: M | null }>(`/api/models/${name}`).then(({ state }) => state)

export const writeModel = (name: string, state: unknown) =>
  request<void>(`/api/models/${name}`, state)

export const health = () =>
  request<Health>("/api/health")

if (import.meta.main) {
  const [command, name = "", day] = process.argv.slice(2).filter(arg => !arg.startsWith("--"))
  if (command === "rows") {
    const rows = await readRows<{ at?: number }>(name, day)
    const ats = rows.flatMap(({ at }) => at === undefined ? [] : [at])
    console.log(`${name}${day ? ` ${day}` : ""}: ${rows.length} rows` + (ats.length ? `, at ${Math.min(...ats)} to ${Math.max(...ats)}` : ""))
  }
  else
    console.log(JSON.stringify(await health(), null, 2))
}
