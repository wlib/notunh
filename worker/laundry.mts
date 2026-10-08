// Every laundry machine's status changes, polled every 5 minutes while Durham's awake and every 15 overnight, for
// the nightly build to learn when each room is usually busy. Status changes stay sparse, with one current snapshot
// per room per poll, and these polls send no User-Agent or other header of ours. And the page's rooms: each one live
// from the vendor cached for 30 seconds per edge, with the collector's records filling in
// when the vendor can't answer, and every room's counts at once from those records alone

import { drizzle } from "drizzle-orm/d1"
import { eq, max } from "drizzle-orm"
import { ROOMS } from "../src/laundry/rooms.mts"
import { fetchMachines } from "../src/laundry/upstream.mts"
import { pollMinutes } from "../src/laundry/model.mts"
import { assess, summarize, type History, type Machine, type RoomLive, type Status, type Summaries, type Transition } from "../src/laundry/infer.mts"
import { latest, polls, transitions, roomSnapshots } from "./schema.mts"
import { chunks, excluded } from "./rows.mts"
import type { Env, Job } from "./collect.mts"

/** The trigger in wrangler.jsonc: every 5 minutes, 2 minutes past, to keep the vendor's load off the busiest minutes */
const CRON = "2-59/5 * * * *"
const OFFSET = 2

// A Worker holds 6 connections open at once, so rooms are fetched that many at a time, each timed from its own start
const AT_ONCE = 6
// A room taking longer has stalled, and shouldn't hold up the rest
const ROOM_TIMEOUT_MS = 8000

// D1 allows 100 bound parameters a statement and, on the free plan, 50 queries a run. A first run sees every
// machine as new, so changes past this, 12 inserts of transitions and 21 of latest, wait for the next run, which
// sees them as new again
const MAX_CHANGES = 168

// Seconds a room's answer is shared between everyone looking, and every room's counts
const LIVE_SECONDS = 30
const SUMMARY_SECONDS = 300

/**
 * The transitions to record: every machine whose status differs from what we last stored, or that we've never seen.
 * A change happened since the last poll; a stamp from since then says when, and an older one, from before the
 * vendor's own cache caught up, says nothing, so it's put halfway
 */
export const diff = (stored: ReadonlyMap<string, Status>, seen: readonly Machine[], at: number, previousAt = at): Transition[] =>
  seen
    .filter(m => stored.get(m.id) !== m.status)
    .map(m => ({
      machine:   m.id,
      room:      m.room,
      at:        !stored.has(m.id) ? at : m.at > previousAt ? Math.min(m.at, at) : Math.round((previousAt + at) / 2),
      status:    m.status,
      raw:       m.raw,
      remaining: m.remaining,
      cycle:     m.cycle
    }))

const record = async (env: Env, at: number, seen: readonly Machine[], failed: string[]) => {
  const db = drizzle(env.DB)
  const [stored, [last]] = await db.batch([
    db.select({ machine: latest.machine, status: latest.status }).from(latest),
    db.select({ at: max(polls.at) }).from(polls)
  ])
  const changes = diff(new Map(stored.map(({ machine, status }) => [machine, status])), seen, at, last?.at ?? at)
    .slice(0, MAX_CHANGES)
  const changedAt = new Map(changes.map(change => [change.machine, change.at]))
  const rows = seen
    .filter(m => changedAt.has(m.id))
    .map(m => ({
      machine: m.id, room: m.room, kind: m.kind, number: m.number, model: m.model, stack: m.stack ?? null, status: m.status,
      raw: m.raw, at: changedAt.get(m.id)!, reported: m.at, remaining: m.remaining, cycle: m.cycle ?? null
    }))
  const snapshots = [...Map.groupBy(seen, m => m.room)].map(([room, machines]) => ({ room, at, machines }))
  await db.batch([
    db.insert(polls).values({ at, failed }).onConflictDoNothing(),
    ...chunks(roomSnapshots, snapshots).map(chunk =>
      db.insert(roomSnapshots).values(chunk).onConflictDoUpdate({ target: roomSnapshots.room, set: excluded(roomSnapshots) })
    ),
    ...chunks(transitions, changes).map(chunk =>
      db.insert(transitions).values(chunk.map(change => ({ ...change, cycle: change.cycle ?? null })))
    ),
    ...chunks(latest, rows).map(chunk =>
      db.insert(latest).values(chunk).onConflictDoUpdate({ target: latest.machine, set: excluded(latest) })
    )
  ])
}

/** Each room's machines, a few rooms at a time, with nothing usable from a room counting as failing to fetch it */
const fetchAll = async (signal: AbortSignal) => {
  const results: PromiseSettledResult<Machine[]>[] = []
  for (let i = 0; i < ROOMS.length && !signal.aborted; i += AT_ONCE)
    results.push(...await Promise.allSettled(ROOMS.slice(i, i + AT_ONCE).map(async ({ id }) => {
      const machines = await fetchMachines(id, AbortSignal.any([signal, AbortSignal.timeout(ROOM_TIMEOUT_MS)]))
      if (!machines.length)
        throw new Error(`No machines in ${id}`)
      return machines
    })))
  return results
}

export const collector: Job = {
  cron: CRON,
  run: async (env, at, signal) => {
    // Overnight only every third run polls
    if ((at / 60_000 - OFFSET) % pollMinutes(at))
      return
    const results = await fetchAll(signal)
    const failed = ROOMS.filter((_, i) => results[i]?.status !== "fulfilled").map(({ id }) => id)
    if (failed.length)
      console.warn(`Laundry rooms failed: ${failed.join(", ")}`)
    await record(env, at, results.flatMap(result => result.status === "fulfilled" ? result.value : []), failed)
  }
}

/**
 * Answers from the edge's cache while fresh, and otherwise makes the answer and keeps it there that long, but not in
 * browsers. Cached by the path and only that, so a made-up query can't skip the cache and reach the vendor
 */
const cached = async (request: Request, seconds: number, make: () => Promise<Response>) => {
  const { origin, pathname } = new URL(request.url)
  const key = new Request(origin + pathname)
  const hit = await caches.default.match(key)
  if (hit)
    return hit
  const response = await make()
  if (response.ok) {
    response.headers.set("cache-control", `public, max-age=0, s-maxage=${seconds}`)
    await caches.default.put(key, response.clone())
  }
  return response
}

type Row = typeof latest.$inferSelect

const fromLatest = (row: Row): Machine => ({
  id:        row.machine,
  room:      row.room,
  number:    row.number,
  kind:      row.kind,
  model:     row.model,
  stack:     row.stack ?? undefined,
  status:    row.status,
  raw:       row.raw,
  at:        row.reported,
  remaining: row.remaining,
  cycle:     row.cycle ?? undefined
})

/** What the collector last recorded of a room: when its machines last reported, the machines, and their histories */
const recorded = (rows: readonly Row[]) => {
  const roomChangedAt = Math.max(0, ...rows.map(row => row.at))
  return {
    at:       Math.max(...rows.map(row => row.reported)),
    machines: rows.map(fromLatest),
    history:  Object.fromEntries(rows.map(row => [row.machine, { changedAt: row.at, roomChangedAt }])) as Record<string, History>
  }
}

/** The vendor's word on a room, asked with the asker's own User-Agent since it's their request, or our last record of it */
const live = async (request: Request, env: Env, room: string) => {
  const userAgent = request.headers.get("user-agent")
  const [fetched, stored, snapshots] = await Promise.allSettled([
    fetchMachines(room, AbortSignal.timeout(ROOM_TIMEOUT_MS), userAgent ? { "user-agent": userAgent } : {}),
    drizzle(env.DB).select().from(latest).where(eq(latest.room, room)),
    drizzle(env.DB).select().from(roomSnapshots).where(eq(roomSnapshots.room, room))
  ])
  const rows = stored.status === "fulfilled" ? stored.value : []
  const { history, ...record } = recorded(rows)
  const snapshot = snapshots.status === "fulfilled" ? snapshots.value[0] : undefined
  const last = snapshot ? { at: snapshot.at, machines: snapshot.machines } : record
  // A room that answers with no machines has changed shape upstream, which is no better than not answering
  if (fetched.status === "fulfilled" && fetched.value.length)
    return Response.json({ at: Date.now(), isStale: false, machines: fetched.value, history } satisfies RoomLive)
  console.warn(fetched.status === "rejected" ? fetched.reason : `No machines in ${room}`)
  return last.machines.length
    ? Response.json({ ...last, isStale: true, history } satisfies RoomLive)
    : new Response("Room unavailable", { status: 502 })
}

/** Each room's counts as of the collector's last record of it, for the list of rooms */
const summaries = async (env: Env) => {
  const now = Date.now()
  const db = drizzle(env.DB)
  const [rows, snapshots] = await db.batch([db.select().from(latest), db.select().from(roomSnapshots)])
  const rooms = Map.groupBy(rows, row => row.room)
  const current = new Map(snapshots.map(snapshot => [snapshot.room, snapshot]))
  for (const snapshot of snapshots)
    if (!rooms.has(snapshot.room))
      rooms.set(snapshot.room, [])
  return Response.json({
    at: now,
    rooms: Object.fromEntries([...rooms].map(([room, rows]) => {
      const { history, ...record } = recorded(rows)
      const { at, machines } = current.get(room) ?? record
      return [room, { at, ...summarize(machines, machines.map(m => assess(m, now, history[m.id]))) }]
    }))
  } satisfies Summaries)
}

export const room = (request: Request, env: Env, id: string) =>
  cached(request, LIVE_SECONDS, () => live(request, env, id))

export const rooms = (request: Request, env: Env) =>
  cached(request, SUMMARY_SECONDS, () => summaries(env))
