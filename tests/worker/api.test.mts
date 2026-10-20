/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import type { Visit } from "../../src/transit/inference/events.mts"
import { serviceDayStart } from "../../src/transit/feed.mts"
import { type Day, HOUR, addDays, dayStart } from "../../src/shared/time.mts"
import { app } from "../../worker/api.mts"
import { archivedSpans, prune } from "../../worker/rows.mts"
import type { Env } from "../../worker/collect.mts"
import { ROOMS } from "../../src/laundry/rooms.mts"
import { health, readModel, readRows, request, storage, writeModel, writeRows } from "../../scripts/worker.mts"
import { learn } from "../../scripts/learn.mts"
import { archiveFeed } from "../../scripts/map/replay.mts"
import { checkpointOf } from "../../src/shared/learn.mts"
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
  env = { DB, ASSETS, RETAIN_DAYS: 60, RETAIN_ARCHIVED_DAYS: 14, RETAIN_VISIT_DAYS: 365, RETAIN_SUMMARY_DAYS: 400, BUILD_TOKEN: token } as unknown as Env
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
    umo:       maybe(fc.array(fc.option(fc.integer({ min: NOON, max: NOON + 3600 }), { nil: null }), { minLength: 5, maxLength: 5 })),
    // What the location model's extractor adds
    spread:    maybe(fc.array(fc.integer({ min: NOON, max: NOON + 3600 }), { minLength: 4, maxLength: 4 })),
    dwelled:   maybe(fc.double({ min: 0, max: 1, noNaN: true })),
    flags:     maybe(fc.nat(3)),
    profile:   maybe(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 })),
    extractor: maybe(fc.constantFrom(1, 2))
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

/** Ways a body of rows can be wrong: a visit missing what it must have or with the wrong type of thing, too many rows, or no day to clear */
const wrong = fc.oneof(
  fc.tuple(fc.constantFrom("vehicle", "route", "stop", "arrive", "depart"), fc.constantFrom(undefined, null, true, [], {}, "the other type")).map(([key, value]) =>
    ([first, ...rest]: Visit[]) => {
      const other = typeof first[key as keyof Visit] === "string" ? 1 : "1"
      return { rows: [{ ...first, [key]: value === "the other type" ? other : value }, ...rest] }
    }
  ),
  fc.constant((rows: Visit[]) => ({ rows: Array.from({ length: 5000 }, () => rows[0]) })),
  fc.constantFrom(null, "2026-11-01", { visits: [] }).map(rows => () => ({ rows })),
  fc.constantFrom("Sunday", "2026-13-01", 20261101).map(clear => (rows: Visit[]) => ({ rows, clear }))
)

test("a body of rows that isn't as the table's are is refused with a 400, and stores nothing", async () =>
  fc.assert(fc.asyncProperty(visits(5).filter(rows => rows.length > 0), wrong, async (rows, spoil) => {
    worker(TOKEN)
    await expect(request("/api/rows/visits", spoil(rows))).rejects.toThrow("400")
    expect(count("visits")).toBe(0)
  }), { numRuns: 50 })
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

/** Stores a model as a build that read the latest first does */
const store = async (name: string, state: { through: string, version?: string }) =>
  writeModel(name, state, (await readModel(name)).revision ?? null)

test("the latest model of a name is the last stored, whatever day it's through, and only the last 30 stored are kept", async () => {
  expect(await readModel("laundry")).toEqual({ state: null, revision: null, throughs: [] })
  const days = fc.sample(fc.shuffledSubarray(Array.from({ length: 40 }, (_, i) => addDays(SUNDAY, i)), { minLength: 40 }), 1)[0]
  for (const through of days)
    await store("laundry", { through })
  await store("buses", { through: SUNDAY })
  expect(await readModel("laundry")).toEqual({ state: { through: days.at(-1) }, revision: expect.any(String), throughs: days.slice(10).sort() })
  expect((await health()).models).toEqual({ buses: SUNDAY, laundry: days.at(-1), gtfs: null })
  await expect(writeModel("laundry", { through: null }, null)).rejects.toThrow("400")
  await expect(writeModel("laundry", { through: SUNDAY }, undefined as unknown as null)).rejects.toThrow("400")
  await expect(writeModel("anything", { through: SUNDAY }, null)).rejects.toThrow("404")
})

test("a refit's checkpoint through an earlier day than the model it replaces is what's read back, kept however old, and only stored over by a writer that read it (Astra's checkpoint probe)", async () => {
  for (let i = 0; i < 40; i++)
    await store("buses", { through: addDays(SUNDAY, i), version: "1" })
  const { revision: old } = await readModel("buses")
  await writeModel("buses", { through: SUNDAY, version: "2" }, old!)
  expect(await readModel("buses")).toMatchObject({ state: { through: SUNDAY, version: "2" }, throughs: expect.arrayContaining([SUNDAY]) })
  expect((await health()).models.buses).toBe(SUNDAY)
  // A build that read the model before the checkpoint can't replace the checkpoint, or store past it
  await expect(writeModel("buses", { through: SUNDAY, version: "1" }, old!)).rejects.toThrow("409")
  await expect(writeModel("buses", { through: addDays(SUNDAY, 40), version: "1" }, old!)).rejects.toThrow("409")
  expect((await readModel("buses")).state).toEqual({ through: SUNDAY, version: "2" })
})

/**
 * Learns a model of a version through a day as production's build does, failing to read one day if asked, with the
 * days it folded and what it bundled
 */
const learnThrough = async (version: number, last: Day, unreadable?: Day) => {
  type Model = { version: number, through: Day | null }
  vi.stubEnv("WORKERS_CI_BRANCH", "main")
  const folded: Day[] = []
  const output = pathToFileURL(`${tmpdir()}/notunh-learn-${crypto.randomUUID()}.json`)
  await learn<Model>("buses", output, {
    empty: () => ({ version, through: null }),
    first: async () => SUNDAY,
    last,
    fold:  async (model, day) => {
      if (day === unreadable)
        throw new Error("unreadable")
      folded.push(day)
      return { ...model, through: day }
    }
  })
  return { folded, bundled: JSON.parse(await readFile(output, "utf8")) as Model }
}

const daysFrom = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => addDays(SUNDAY, from + i))

test("a refit of a new version stopped partway is stored, and the next build carries on from it rather than starting over", async () => {
  await learnThrough(1, addDays(SUNDAY, 18))
  expect((await learnThrough(2, addDays(SUNDAY, 18), addDays(SUNDAY, 11))).folded).toEqual(daysFrom(0, 10))
  const { folded, bundled } = await learnThrough(2, addDays(SUNDAY, 18))
  expect(folded).toEqual(daysFrom(11, 18))
  expect(bundled).toEqual({ version: 2, through: addDays(SUNDAY, 18) })
})

test("a build by hand, or a preview's, only reads, unless told to store what it learns", async () => {
  await learnThrough(1, addDays(SUNDAY, 3))
  const published = await readModel("buses")
  for (const [branch, store] of [["", ""], ["preview", ""], ["", "1"]]) {
    vi.stubEnv("WORKERS_CI_BRANCH", branch || undefined as unknown as string)
    vi.stubEnv("NOTUNH_STORE", store)
    const output = pathToFileURL(`${tmpdir()}/notunh-learn-${crypto.randomUUID()}.json`)
    await learn<{ version: number, through: Day | null }>("buses", output, { empty: () => ({ version: 1, through: null }), first: async () => SUNDAY, last: addDays(SUNDAY, 5), fold: async (model, day) => ({ ...model, through: day }) })
    expect((await readModel("buses")).state).toEqual(store ? { version: 1, through: addDays(SUNDAY, 5) } : published.state)
  }
})

test("a rebuild learns on in its checkpoint over several builds while the model it replaces stays published and bundled, until it's caught up", async () => {
  await learnThrough(1, addDays(SUNDAY, 18))
  vi.stubEnv("MODEL_REBUILD", "1")
  const first = await learnThrough(1, addDays(SUNDAY, 18), addDays(SUNDAY, 8))
  vi.stubEnv("MODEL_REBUILD", "")
  expect(first).toEqual({ folded: daysFrom(0, 7), bundled: { version: 1, through: addDays(SUNDAY, 18) } })
  expect((await readModel("buses")).state).toEqual({ version: 1, through: addDays(SUNDAY, 18) })
  expect((await readModel(checkpointOf("buses"))).state).toEqual({ version: 1, through: addDays(SUNDAY, 7) })
  expect(await learnThrough(1, addDays(SUNDAY, 19))).toEqual({ folded: daysFrom(8, 19), bundled: { version: 1, through: addDays(SUNDAY, 19) } })
  expect((await readModel("buses")).state).toEqual({ version: 1, through: addDays(SUNDAY, 19) })
})

test("against a Worker from before model revisions, a build only reads, storing nothing, and bundles what's stored if it's of this version", async () => {
  const stored = { version: 1, through: addDays(SUNDAY, 3) }
  const posts: unknown[] = []
  // As main's Worker answers: the latest state alone, and a POST of a state itself stored over whatever's there
  vi.stubGlobal("fetch", async (_: string, init?: RequestInit) => {
    if (init?.method !== "POST")
      return Response.json({ state: stored })
    const { through } = JSON.parse(`${init.body}`)
    posts.push(through)
    return new Response(null, { status: typeof through === "string" ? 204 : 400 })
  })
  expect(await learnThrough(1, addDays(SUNDAY, 18))).toEqual({ folded: [], bundled: stored })
  expect((await learnThrough(2, addDays(SUNDAY, 18))).bundled).toEqual({ version: 2, through: null })
  expect(posts).toEqual([])
})

test("a model is only stored over the revision its writer read, so of two builds learning at once the second's 409s, even replacing the same day", async () => {
  await writeModel("buses", { through: SUNDAY, n: 1 }, null)
  // Both read SUNDAY's; the first to store wins, and the other learns that rather than overwriting it
  const { revision: first } = await readModel("buses")
  await writeModel("buses", { through: addDays(SUNDAY, 1), n: 2 }, first!)
  await expect(writeModel("buses", { through: addDays(SUNDAY, 1), n: 3 }, first!)).rejects.toThrow("409")
  await expect(writeModel("buses", { through: addDays(SUNDAY, 2), n: 3 }, null)).rejects.toThrow("409")
  // The same day again, by a build that read it, replaces it, as a rebuild does, under a new revision, so a second
  // writer that read the same day's earlier revision can't replace it too (Astra's same-day probe)
  const { revision: second } = await readModel("buses")
  expect(second).not.toBe(first)
  await writeModel("buses", { through: addDays(SUNDAY, 1), n: 4 }, second!)
  await expect(writeModel("buses", { through: addDays(SUNDAY, 1), n: 5 }, second!)).rejects.toThrow("409")
  expect(await readModel("buses")).toMatchObject({ state: { through: addDays(SUNDAY, 1), n: 4 }, throughs: [SUNDAY, addDays(SUNDAY, 1)] })
})

test("the timetable is read back by the day it was in force, as the version archived last at or before it", async () => {
  for (const [i, version] of ["spring", "fall"].entries())
    await store("gtfs", { through: addDays(SUNDAY, 10 * i), version })
  const versionOf = async (day: string) => (await readModel<{ version: string }>("gtfs", day)).state?.version ?? null
  expect(await Promise.all([addDays(SUNDAY, -1), SUNDAY, addDays(SUNDAY, 9), addDays(SUNDAY, 10), addDays(SUNDAY, 99)].map(versionOf)))
    .toEqual([null, "spring", "spring", "fall", "fall"])
  expect((await readModel("gtfs")).throughs).toEqual([SUNDAY, addDays(SUNDAY, 10)])
})

test("two timetable versions first seen the same day are both archived, the first as of that day and the second as of the next (Astra's same-day feed)", async () => {
  const feed = (version: string) => ({ version, start: SUNDAY, end: SUNDAY, routes: [], stops: [], services: {}, trips: [], shapes: {} })
  expect(await archiveFeed(feed("spring"), SUNDAY)).toBe(true)
  expect(await archiveFeed(feed("fall"), SUNDAY)).toBe(true)
  expect(await archiveFeed(feed("fall"), SUNDAY)).toBe(false)
  const versionOf = async (day: string) => (await readModel<{ version: string }>("gtfs", day)).state?.version
  expect([await versionOf(SUNDAY), await versionOf(addDays(SUNDAY, 1))]).toEqual(["spring", "fall"])
  // Back to the first version that day, it's archived again after the second, which it replaces from then on
  expect(await archiveFeed(feed("spring"), SUNDAY)).toBe(true)
  expect((await readModel("gtfs")).throughs).toEqual([SUNDAY, addDays(SUNDAY, 1), addDays(SUNDAY, 2)])
})

test("storage says how big the database is, in bytes and rows a table", async () => {
  await writeRows("visits", Array.from({ length: 3 }, (_, i): Visit => ({ vehicle: "T-51", route: "3", stop: "101", arrive: NOON + i, depart: NOON + i })))
  const { bytes, rows } = await storage()
  expect(bytes).toBeGreaterThan(4096)
  expect(rows).toEqual({ samples: 0, visits: 3, summaries: 0, models: 0, transitions: 0, latest: 0, polls: 0, room_snapshots: 0 })
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
    summaries:   { since: null, last: null },
    models:      { buses: null, laundry: null, gtfs: null }
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

test("the nightly prune drops samples past two weeks only of days the archive has, and past 60 days whatever it has", async () => {
  const today = "2026-10-07"
  const noon = (days: number) => serviceDayStart(addDays(today, -days)) + 12 * HOUR
  const ages = [70, 61, 60, 40, 30, 20, 15, 14, 13, 1]
  for (const days of ages)
    for (const source of ["buses", "predictions"])
      sqlite.prepare("insert into samples (source, at, body) values (?, ?, x'00')").run(source, noon(days))
  // Archived: one past the cap, two in the window's reach, and two it keeps however archived
  await prune(env, today, [70, 40, 20, 14, 1].map(days => addDays(today, -days)))
  const kept = sqlite.prepare("select distinct at from samples order by at").all().map(({ at }) => at)
  expect(kept).toEqual([60, 30, 15, 14, 13, 1].map(noon))
})

test("the samples pruned early are the archived days between the window and the cap, as spans that meet merged", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: -5, max: 80 })), fc.integer({ min: 1, max: 30 }), fc.integer({ min: 30, max: 70 }), (ages, window, cap) => {
    const today = "2026-10-07"
    const spans = archivedSpans(today, ages.map(days => addDays(today, -days)), window, cap)
    const goes = (days: number) => spans.some(([from, to]) => from <= serviceDayStart(addDays(today, -days)) + 12 * HOUR && serviceDayStart(addDays(today, -days)) + 12 * HOUR < to)
    for (let days = -5; days <= 80; days++)
      expect(goes(days)).toBe(ages.includes(days) && days > window && days <= cap)
    for (let i = 1; i < spans.length; i++)
      expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1])
  }))
)

test("a day's summary is stored and read back by its service day, and storing the day again replaces it", async () => {
  const at = serviceDayStart(SUNDAY)
  const summary = (version: number) => ({ at, version, extractor: 2, state: { legs: [[1, 2.5]], version } })
  await writeRows("summaries", [summary(1)], SUNDAY)
  expect(await readRows("summaries", SUNDAY)).toEqual([summary(1)])
  await writeRows("summaries", [summary(2)], SUNDAY)
  expect(await readRows("summaries", SUNDAY)).toEqual([summary(2)])
  expect(await readRows("summaries", addDays(SUNDAY, 1))).toEqual([])
  expect((await health()).summaries).toEqual({ since: at, last: at })
})

test("the nightly prune drops laundry's records of rooms no longer listed, and of machines gone from a room's snapshot", async () => {
  const [room, other] = ROOMS.map(({ id }) => id)
  const insert = (machine: string, room: string) =>
    sqlite.prepare("insert into latest (machine, room, kind, number, model, status, raw, at, reported, remaining) values (?, ?, 'washer', '1', 'm', 'free', '', 0, 0, 0)").run(machine, room)
  const snapshot = (room: string, machines: string[]) =>
    sqlite.prepare("insert into room_snapshots (room, at, machines) values (?, 0, ?)").run(room, JSON.stringify(machines.map(id => ({ id }))))
  insert("kept", room)
  insert("replaced", room)
  insert("unsnapshotted", other)
  insert("closed", "a-room-that-was-closed")
  snapshot(room, ["kept", "new"])
  snapshot("a-room-that-was-closed", ["closed"])
  await prune(env, "2026-10-07")
  expect(sqlite.prepare("select machine from latest order by machine").all().map(({ machine }) => machine)).toEqual(["kept", "unsnapshotted"])
  expect(sqlite.prepare("select room from room_snapshots").all().map(({ room }) => room)).toEqual([room])
})

test("the build's routes are only the build's", async () => {
  for (const [token, given] of [[TOKEN, "wrong"], [TOKEN, ""], [undefined, TOKEN], [undefined, "undefined"]]) {
    worker(token, given)
    for (const name of ["visits", "machines"])
      await expect(readRows(name)).rejects.toThrow(/40[01]/)
    await expect(writeRows("visits", [], SUNDAY)).rejects.toThrow(/40[01]/)
    await expect(readModel("buses")).rejects.toThrow(/40[01]/)
    await expect(writeModel("buses", { version: 1, through: SUNDAY }, null)).rejects.toThrow(/40[01]/)
    await expect(storage()).rejects.toThrow(/40[01]/)
  }
  worker(TOKEN)
  await expect(readRows("nothing")).rejects.toThrow("404")
  await expect(writeRows("transitions", [], SUNDAY)).rejects.toThrow("404")
})
