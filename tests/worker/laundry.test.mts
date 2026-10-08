import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import type { Machine, RoomLive, Status, Summaries } from "../../src/laundry/infer.mts"
import { parseMachines } from "../../src/laundry/upstream.mts"
import { ROOMS } from "../../src/laundry/rooms.mts"
import { diff, collector } from "../../worker/laundry.mts"
import { app } from "../../worker/api.mts"
import type { Env } from "../../worker/collect.mts"
import { d1 } from "./d1.mts"
import at163002 from "../laundry/fixtures/stoke-g05-163002.json"
import at163012 from "../laundry/fixtures/stoke-g05-163012.json"
import at163257 from "../laundry/fixtures/stoke-g05-163257.json"
import at163302 from "../laundry/fixtures/stoke-g05-163302.json"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const STOKE = "loc_ffa038"
const NOW = Date.parse("2026-10-07T16:33:02Z")

const statuses = (machines: readonly Machine[]) =>
  new Map(machines.map(({ id, status }) => [id, status]))

const seen = fc.array(
  fc.record({ id: fc.constantFrom("a", "b", "c", "d", "e"), status: fc.constantFrom<Status>("free", "running", "done", "out"), at: fc.integer({ min: NOW - 600_000, max: NOW + 60_000 }) }),
  { maxLength: 5 }
).map(list => [...new Map(list.map(m => [m.id, m])).values()].map(({ id, status, at }): Machine =>
  ({ id, room: "r", number: id, kind: "washer", model: "", status, raw: "", at, remaining: 0 })
))

test("recording a poll's transitions brings the latest statuses up to it, dated since the last poll, and a poll with no change records nothing", () =>
  fc.assert(fc.property(seen, seen, (before, after) => {
    const latest = statuses(before)
    const transitions = diff(latest, after, NOW, NOW - 300_000)
    const applied = new Map(latest)
    for (const { machine, status, at } of transitions) {
      applied.set(machine, status)
      expect(at).toBeLessThanOrEqual(NOW)
      expect(at).toBeGreaterThanOrEqual(NOW - 300_000)
    }
    expect(applied).toEqual(new Map([...latest, ...statuses(after)]))
    expect(diff(applied, after, NOW)).toEqual([])
  }))
)

test("replaying Stoke G05's four snapshots records just dryer 10 finishing and washer 3 being emptied", () => {
  const snapshots = [at163002, at163012, at163257, at163302].map(body => parseMachines(STOKE, body))
  const times = ["16:30:02", "16:30:12", "16:32:57", "16:33:02"].map(time => Date.parse(`2026-10-07T${time}Z`))
  let latest = statuses(snapshots[0])
  const recorded = snapshots.slice(1).flatMap((machines, i) => {
    const transitions = diff(latest, machines, times[i + 1], times[i])
    latest = new Map([...latest, ...statuses(machines)])
    return transitions
  })
  const number = (id: string) => snapshots[0].find(m => m.id === id)!.number
  expect(recorded.map(({ machine, status }) => [number(machine), status])).toEqual([["3", "free"], ["10", "done"]])
  // Dryer 10 reported finishing at 16:30:23, after the poll before, but washer 3's stamp predates it, so it's put halfway
  expect(recorded.map(({ at }) => new Date(at).toISOString())).toEqual(["2026-10-07T16:31:34.500Z", "2026-10-07T16:30:23.270Z"])
})

/** The vendor, answering for each room with a snapshot whose machine ids are the room's own */
const vendor = (body: { data: unknown[] } | number, requests: Request[] = []) =>
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    requests.push(new Request(input, init))
    const room = input.match(/locations\/(\w+)\/machines/)![1]
    return typeof body === "number"
      ? new Response("", { status: body })
      : Response.json({ data: body.data.map((m: any) => ({ ...m, id: `${room}-${m.id}` })) })
  })

/** The built site, of which only the laundry page matters here */
const ASSETS = {
  fetch: async (input: URL | Request) =>
    new URL(input instanceof Request ? input.url : input).pathname === "/laundry/" ? new Response("the laundry page") : new Response("", { status: 404 })
}

const environment = () => {
  const DB = d1()
  return { env: { DB, ASSETS, RETAIN_DAYS: 60 } as unknown as Env, sqlite: DB.sqlite }
}

const count = (sqlite: ReturnType<typeof environment>["sqlite"], table: string) =>
  (sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

// 6:02 PM in Durham, EDT, and the runs every 5 minutes from then
const EVENING = Date.parse("2026-10-07T22:02:00Z")
const RUNS = [0, 1, 2, 3].map(run => EVENING + run * 300_000)

const run = (env: Env, at: number) =>
  collector.run(env, at, new AbortController().signal)

test("the collector asks every room with no User-Agent of ours, writes a first sighting of every machine over three runs, then only changes", async () => {
  const requests: Request[] = []
  const { env, sqlite } = environment()

  vendor(at163002, requests)
  // 3:07 AM, which overnight is skipped
  await run(env, Date.parse("2026-10-08T07:07:00Z"))
  expect(requests).toHaveLength(0)

  await run(env, RUNS[0])
  expect(requests).toHaveLength(ROOMS.length)
  for (const request of requests)
    expect(request.headers.get("user-agent")).toBeNull()
  await run(env, RUNS[1])
  await run(env, RUNS[2])
  expect(count(sqlite, "latest")).toBe(ROOMS.length * 11)
  expect(count(sqlite, "transitions")).toBe(ROOMS.length * 11)

  vendor(at163257)
  await run(env, RUNS[3])
  expect(count(sqlite, "transitions")).toBe(ROOMS.length * 13)
  expect(sqlite.prepare("select status from latest where machine = ?").get(`${STOKE}-mac_572309`)).toEqual({ status: "free" })
  expect(sqlite.prepare("select at, failed from polls order by at").all()).toEqual(RUNS.map(at => ({ at, failed: "[]" })))
})

test("a room that answers with nothing usable counts as not fetched", async () => {
  const { env, sqlite } = environment()
  vendor({ data: [{ unexpected: true }] })
  await run(env, EVENING)
  expect(count(sqlite, "transitions")).toBe(0)
  expect(JSON.parse((sqlite.prepare("select failed from polls").get() as { failed: string }).failed)).toHaveLength(ROOMS.length)
})

const cache = () => {
  const entries = new Map<string, Response>()
  return {
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void entries.set(request.url, response)
  }
}

const ask = (env: Env, path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://notunh.app${path}`, init), env)

test("a room's live status is asked for with the asker's own User-Agent, shared for 30 s at the edge only, and not for made-up rooms", async () => {
  const requests: Request[] = []
  vi.stubGlobal("caches", { default: cache() })
  vendor(at163302, requests)
  const { env } = environment()
  const headers = { "user-agent": "Phone/1" }

  const response = await ask(env, `/api/laundry/rooms/${STOKE}`, { headers })
  expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30")
  expect((await response.json<RoomLive>()).machines).toHaveLength(11)
  expect((await ask(env, `/api/laundry/rooms/${STOKE}?skip=cache`, { headers })).ok).toBe(true)
  expect((await ask(env, "/api/laundry/rooms/loc_000000", { headers })).status).toBe(404)
  expect(requests).toHaveLength(1)
  expect(requests[0].headers.get("user-agent")).toBe("Phone/1")
})

test("when the vendor can't answer, a room is the collector's last record of it, marked stale, as of the machines' last word", async () => {
  const { env } = environment()
  vendor(at163302)
  // A first sighting of every machine takes three runs
  for (const at of RUNS.slice(0, 3))
    await run(env, at)
  vi.stubGlobal("caches", { default: cache() })
  vendor(503)
  const live = await (await ask(env, `/api/laundry/rooms/${STOKE}`)).json<RoomLive>()
  expect(live.isStale).toBe(true)
  expect(live.machines).toHaveLength(11)
  expect(live.at).toBe(RUNS[2])
  expect(Object.keys(live.history)).toHaveLength(11)
})

test("every room's counts come from the collector's records alone, shared for 5 minutes at the edge", async () => {
  const { env } = environment()
  vendor(at163302)
  for (const at of RUNS.slice(0, 3))
    await run(env, at)
  const requests: Request[] = []
  vendor(503, requests)
  vi.stubGlobal("caches", { default: cache() })
  const response = await ask(env, "/api/laundry/rooms")
  expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300")
  const { rooms } = await response.json<Summaries>()
  expect(Object.keys(rooms)).toHaveLength(ROOMS.length)
  expect(rooms[STOKE]).toMatchObject({ washer: { total: 6 }, dryer: { total: 5 } })
  expect(requests).toHaveLength(0)
})

test("a room's own address is the laundry page, and a made-up one isn't", async () => {
  const { env } = environment()
  const slug = ROOMS[0].name.toLowerCase().replaceAll(" ", "-")
  expect(await (await ask(env, `/laundry/${slug}/`)).text()).toBe("the laundry page")
  expect((await ask(env, "/laundry/nowhere-hall/")).status).toBe(404)
})


test("unchanged machines retain fresh heartbeats and extended timers without adding transitions", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  const { env, sqlite } = environment()
  const snapshot = (at: number, neighbor: string, remaining: number) => ({ data: [
    { id: "idle", machineNumber: "1", modelNumber: "W", machineType: { isDryer: false }, status: { statusId: "AVAILABLE", receivedAt: new Date(at).toISOString(), remainingSeconds: 0 } },
    { id: "running", machineNumber: "2", modelNumber: "D", machineType: { isDryer: true }, status: { statusId: "IN_USE", receivedAt: new Date(at).toISOString(), remainingSeconds: remaining } },
    { id: "neighbor", machineNumber: "3", modelNumber: "W", machineType: { isDryer: false }, status: { statusId: neighbor, receivedAt: new Date(at).toISOString(), remainingSeconds: 300 } }
  ] })
  vi.setSystemTime(EVENING)
  vendor(snapshot(EVENING, "AVAILABLE", 600))
  await run(env, EVENING)
  const transitions = count(sqlite, "transitions")
  const later = EVENING + 4 * 86_400_000
  vi.setSystemTime(later)
  vendor(snapshot(later, "IN_USE", 1800))
  await run(env, later)
  expect(count(sqlite, "transitions")).toBe(transitions + ROOMS.length)
  vi.stubGlobal("caches", { default: cache() })
  const summaries = await (await ask(env, "/api/laundry/rooms")).json<Summaries>()
  expect(summaries.rooms[STOKE].washer).toMatchObject({ total: 2, free: 1, out: 0 })
  expect(summaries.rooms[STOKE].dryer).toMatchObject({ nextAt: later + 1_800_000, isSure: true })
  vendor(503)
  const fallback = await (await ask(env, `/api/laundry/rooms/${STOKE}`)).json<RoomLive>()
  expect(fallback.isStale).toBe(true)
  expect(fallback.at).toBe(later)
  expect(fallback.machines.find(m => m.id.endsWith("-running"))).toMatchObject({ at: later, remaining: 1800 })
})
