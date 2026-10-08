/// <reference types="node" />
import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import type { Visit } from "../../src/map/events.mts"
import { serviceDayStart } from "../../src/map/feed.mts"
import { HOUR, addDays, dayStart } from "../../src/shared/time.mts"
import { app } from "../../worker/api.mts"
import { prune } from "../../worker/rows.mts"
import type { Env } from "../../worker/collect.mts"
import { health, readModel, readRows, writeModel, writeRows } from "../../scripts/worker.mts"
import { d1 } from "./d1.mts"

const TOKEN = "secret"
// The day the clocks fall back, 25 hours long
const SUNDAY = "2026-11-01"
const NOON = serviceDayStart(SUNDAY) / 1000 + 12 * 3600

/** The built site, with nothing at the paths these ask for */
const ASSETS = { fetch: async () => new Response("", { status: 404 }) }

let env: Env
let sqlite: ReturnType<typeof d1>["sqlite"]

/** A Worker with a fresh database, and the build's token for it, or for none when it's given none */
const worker = (token: string | undefined, given = token ?? "") => {
  const DB = d1()
  env = { DB, ASSETS, RETAIN_DAYS: 60, RETAIN_VISIT_DAYS: 365, BUILD_TOKEN: token } as unknown as Env
  sqlite = DB.sqlite
  vi.stubEnv("BUILD_TOKEN", given)
}

const count = (table: string) =>
  (sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

// The build's client, reaching the Worker without a network
beforeEach(() => {
  worker(TOKEN)
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => app.fetch(new Request(input, init), env))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const maybe = <T,>(arbitrary: fc.Arbitrary<T>) =>
  fc.option(arbitrary, { nil: undefined })

/** Visits as extracted, each bus's at distinct times, with whatever they happened to know, as JSON keeps them */
const visits = (maxLength: number) => fc.uniqueArray(
  fc.record({
    vehicle:   fc.constantFrom("T-51", "T-53", "T-60"),
    route:     fc.constantFrom("3", "Gables"),
    stop:      fc.constantFrom("101", "102", "148"),
    arrive:    fc.integer({ min: NOON, max: NOON + 3600 }),
    depart:    fc.integer({ min: NOON, max: NOON + 3600 }),
    trip:      maybe(fc.constantFrom("3B FULL_T04", "Gables Connector_T62")),
    position:  maybe(fc.nat(50)),
    isEnd:     maybe(fc.boolean()),
    scheduled: maybe(fc.integer({ min: NOON, max: NOON + 3600 })),
    from:      maybe(fc.constantFrom("101", "102")),
    meters:    maybe(fc.double({ min: 1, max: 2000, noNaN: true })),
    left:      maybe(fc.integer({ min: NOON - 600, max: NOON })),
    gotIn:     maybe(fc.integer({ min: NOON - 600, max: NOON })),
    umo:       maybe(fc.array(fc.option(fc.integer({ min: NOON, max: NOON + 3600 }), { nil: null }), { minLength: 5, maxLength: 5 }))
  }).map(visit => JSON.parse(JSON.stringify(visit)) as Visit),
  { selector: visit => `${visit.vehicle} ${visit.arrive}`, maxLength }
)

test("a day's visits, written a request at a time, read back as they were sent, and writing the day again replaces them", async () =>
  fc.assert(fc.asyncProperty(visits(450), visits(450), async (first, again) => {
    worker(TOKEN)
    await writeRows("visits", first, SUNDAY)
    expect(await readRows("visits", SUNDAY)).toEqual(first)
    await writeRows("visits", again, SUNDAY)
    expect(await readRows("visits", SUNDAY)).toEqual(again)
    expect(await readRows("visits", addDays(SUNDAY, 1))).toEqual([])
  }), { numRuns: 30 }),
  30_000
)

test("reading follows the pages past the first", async () => {
  const many = Array.from({ length: 1001 }, (_, i): Visit => ({ vehicle: "T-51", route: "3", stop: "101", arrive: NOON + i, depart: NOON + i }))
  await writeRows("visits", many, SUNDAY)
  expect(await readRows("visits", SUNDAY)).toEqual(many)
  expect(await readRows("visits")).toHaveLength(1001)
})

test("transitions and polls read by Durham's calendar day, polls an hour either side too", async () => {
  const start = dayStart(SUNDAY)
  const end = dayStart(addDays(SUNDAY, 1))
  expect(end - start).toBe(25 * HOUR)
  const ats = [start - 2 * HOUR, start - HOUR / 2, start, end - 1, end, end + HOUR / 2, end + 2 * HOUR]
  for (const at of ats) {
    sqlite.prepare("insert into transitions (machine, room, at, status, raw, remaining) values ('m', 'r', ?, 'free', 'AVAILABLE', 0)").run(at)
    sqlite.prepare("insert into polls (at, failed) values (?, '[]')").run(at)
  }
  expect((await readRows<{ at: number }>("transitions", SUNDAY)).map(({ at }) => at)).toEqual([start, end - 1])
  expect(await readRows("polls", SUNDAY)).toEqual(ats.slice(1, -1).map(at => ({ at, failed: [] })))
})

test("the latest model of a name is the one through the latest day, and only the last 30 are kept", async () => {
  expect(await readModel("laundry")).toBeNull()
  const days = fc.sample(fc.shuffledSubarray(Array.from({ length: 40 }, (_, i) => addDays(SUNDAY, i)), { minLength: 40 }), 1)[0]
  for (const through of days)
    await writeModel("laundry", { version: 1, through })
  await writeModel("buses", { version: 1, through: SUNDAY })
  expect(await readModel("laundry")).toEqual({ version: 1, through: addDays(SUNDAY, 39) })
  expect((await health()).models).toEqual({ buses: SUNDAY, laundry: addDays(SUNDAY, 39) })
  expect(sqlite.prepare("select through from models where name = 'laundry' order by through").all().map(({ through }) => through)).toEqual(Array.from({ length: 30 }, (_, i) => addDays(SUNDAY, 10 + i)))
  await expect(writeModel("laundry", { version: 1, through: null })).rejects.toThrow("400")
  await expect(writeModel("anything", { version: 1, through: SUNDAY })).rejects.toThrow("404")
})

test("health says when each table's rows start and end, in its own unit, and the day each model runs through", async () => {
  const at = Date.parse("2026-10-07T16:00:00Z")
  for (const minutes of [0, 1, 7])
    sqlite.prepare("insert into samples (source, at, body) values ('buses', ?, x'00')").run(at + minutes * 60_000)
  await writeRows("visits", [{ vehicle: "T-51", route: "3", stop: "101", arrive: NOON, depart: NOON + 30 }])
  sqlite.prepare("insert into polls (at, failed) values (?, '[]')").run(at)
  expect(await health()).toEqual({
    buses:       { since: at, last: at + 7 * 60_000 },
    predictions: { since: null, last: null },
    visits:      { since: NOON, last: NOON },
    transitions: { since: null, last: null },
    polls:       { since: at, last: at },
    models:      { buses: null, laundry: null }
  })
})

test("the nightly prune drops each table's rows past what it keeps", async () => {
  const today = "2026-10-07"
  const noon = (days: number) => dayStart(addDays(today, -days)) + 12 * HOUR
  for (const days of [61, 60, 59]) {
    sqlite.prepare("insert into samples (source, at, body) values ('buses', ?, x'00')").run(noon(days))
    sqlite.prepare("insert into transitions (machine, room, at, status, raw, remaining) values ('m', 'r', ?, 'free', '', 0)").run(noon(days))
  }
  for (const days of [366, 365, 364])
    sqlite.prepare("insert into visits (vehicle, route, stop, arrive, depart) values ('T-51', '3', '101', ?, 0)").run(noon(days) / 1000)
  await prune(env, today)
  expect([count("samples"), count("transitions"), count("visits")]).toEqual([2, 2, 2])
})

test("the build's routes are only the build's", async () => {
  for (const [token, given] of [[TOKEN, "wrong"], [TOKEN, ""], [undefined, TOKEN], [undefined, "undefined"]]) {
    worker(token, given)
    for (const name of ["visits", "machines"])
      await expect(readRows(name)).rejects.toThrow(/40[01]/)
    await expect(writeRows("visits", [], SUNDAY)).rejects.toThrow(/40[01]/)
    await expect(readModel("buses")).rejects.toThrow(/40[01]/)
    await expect(writeModel("buses", { version: 1, through: SUNDAY })).rejects.toThrow(/40[01]/)
  }
  worker(TOKEN)
  await expect(readRows("nothing")).rejects.toThrow("404")
  await expect(writeRows("transitions", [], SUNDAY)).rejects.toThrow("404")
})
