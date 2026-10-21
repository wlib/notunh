/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import type { Visit } from "../../src/transit/inference/events.mts"
import { serviceDayStart } from "../../src/transit/feed.mts"
import { type Day, HOUR, addDays, dayStart } from "../../src/shared/time.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { app } from "../../worker/api.mts"
import { archivedSpans, prune } from "../../worker/rows.mts"
import type { Env } from "../../worker/env.mts"
import { ROOMS } from "../../src/laundry/rooms.mts"
import { derived, health, readModel, readRows, request, storage, writeModel } from "../../scripts/worker.mts"
import { learn } from "../../scripts/learn.mts"
import { type Acquisition, inEffect } from "../../scripts/map/replay.mts"
import { gunzipJson, gzipJson } from "../../src/shared/json.mts"
import { fromHex } from "../../src/transit/observations/raw.mts"
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
  env = { DB, ASSETS, RETAIN_DAYS: 60, RETAIN_ARCHIVED_DAYS: 14, RETAIN_VISIT_DAYS: 180, RETAIN_STATISTICS_DAYS: 400, BUILD_TOKEN: token } as unknown as Env
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
    profile:   maybe(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 }))
  }).map(visit => JSON.parse(JSON.stringify(visit)) as Visit),
  { selector: visit => `${visit.vehicle} ${visit.arrive}`, maxLength }
)

/** What's derived from a day, as a build publishes it, made of what's given, and whether it was made */
const derive = async <T,>(day: Day, from: object, value: T) => {
  let isMade = false
  const got = await derived("visits", day, from, async () => {
    isMade = true
    return value
  })
  return { got, isMade }
}

test("what's derived from a day is published whole and read back as it was, reused only for exactly what it was derived from, and replaced otherwise", async () =>
  fc.assert(fc.asyncProperty(visits(450), visits(450), fc.nat(3), async (first, again, extractor) => {
    worker(TOKEN)
    expect(await derive(SUNDAY, { extractor }, first)).toEqual({ got: first, isMade: true })
    expect(await derive(SUNDAY, { extractor }, again)).toEqual({ got: first, isMade: false })
    expect(await derive(SUNDAY, { extractor: extractor + 1 }, again)).toEqual({ got: again, isMade: true })
    expect(await derive(addDays(SUNDAY, 1), { extractor: extractor + 1 }, first)).toEqual({ got: first, isMade: true })
    // Each day's generation is all that's kept of it
    expect(count("derived")).toBe(2)
    expect(count("chunks")).toBe(2)
  }), { numRuns: 30 }),
  30_000
)

/** A generation's parts, stored as a build stores them, of a value split into some parts */
const upload = async (value: unknown, parts: number) => {
  const generation = crypto.randomUUID()
  const body = await gzipJson(value)
  const size = Math.ceil(body.length / parts)
  for (let part = 0; part < parts; part++)
    await request(`/api/chunks/${generation}/${part}`, body.subarray(part * size, (part + 1) * size))
  return generation
}

const commit = (generation: string, parts: number, identity = "i") =>
  request(`/api/derived/visits`, { day: SUNDAY, identity, generation, parts })

/** The day's last committed generation, as a reader gets it: what it was derived from, and its value */
const current = async () => {
  const found = await request<{ identity: string, parts: string[] } | null>(`/api/derived/visits?day=${SUNDAY}`)
  return found && { identity: found.identity, value: await gunzipJson(...found.parts.map(fromHex)) }
}

test("a generation is seen whole or not at all: parts without their manifest, or a manifest without all its parts, change nothing, and of two committed the last is kept", async () =>
  fc.assert(fc.asyncProperty(visits(100), visits(100), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), async (a, b, partsA, partsB) => {
    worker(TOKEN)
    // Interrupted before its manifest, or committed with a part missing, as a build cut short or racing another
    // leaves it
    const loose = await upload(a, partsA)
    await expect(commit(loose, partsA + 1)).rejects.toThrow("409")
    expect(await current()).toBeNull()
    // Two builds deriving the day at once, each uploading before either commits
    const [first, second] = [await upload(a, partsA), await upload(b, partsB)]
    await commit(first, partsA)
    expect(await current()).toEqual({ identity: "i", value: a })
    await commit(second, partsB, "j")
    expect(await current()).toEqual({ identity: "j", value: b })
    // The replaced generation's parts went with the commit, and the nightly prune takes what no manifest names
    await prune(env, SUNDAY)
    expect(sqlite.prepare("select distinct generation from chunks").all()).toEqual([{ generation: second }])
    await expect(commit(first, partsA)).rejects.toThrow("409")
    expect(await current()).toEqual({ identity: "j", value: b })
  }), { numRuns: 20 }),
  30_000
)

/** Ways a publication can be wrong: a manifest that isn't one, or a part that isn't one */
const wrong = fc.oneof(
  fc.constantFrom(
    { day: "Sunday" }, { day: SUNDAY, identity: 1 }, { day: SUNDAY, identity: "i", generation: "g", parts: 1 },
    { day: SUNDAY, identity: "i", generation: crypto.randomUUID(), parts: 0 }, { day: SUNDAY, identity: "i", generation: crypto.randomUUID(), parts: 1.5 }
  ).map(manifest => () => request("/api/derived/visits", manifest)),
  fc.constantFrom(["not-a-generation", "0"], [crypto.randomUUID(), "-1"], [crypto.randomUUID(), "x"]).map(([generation, part]) =>
    () => request(`/api/chunks/${generation}/${part}`, new Uint8Array([1]))
  ),
  fc.constant(() => request(`/api/chunks/${crypto.randomUUID()}/0`, new Uint8Array()))
)

test("a publication that isn't as the API takes it is refused with a 400, and stores nothing", async () =>
  fc.assert(fc.asyncProperty(wrong, async spoil => {
    worker(TOKEN)
    await expect(spoil()).rejects.toThrow("400")
    expect([count("derived"), count("chunks")]).toEqual([0, 0])
  }), { numRuns: 30 })
)

test("reading follows the pages past the first", async () => {
  const at = (i: number) => dayStart(SUNDAY) + i
  for (let i = 0; i < 1001; i++)
    sqlite.prepare("insert into transitions (machine, room, at, status, raw, remaining) values ('m', 'r', ?, 'free', '', 0)").run(at(i))
  expect((await readRows<{ at: number }>("transitions", SUNDAY)).map(row => row.at)).toEqual(Array.from({ length: 1001 }, (_, i) => at(i)))
  expect(await readRows("transitions")).toHaveLength(1001)
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
  expect(await readModel("laundry")).toEqual({ state: null, revision: null })
  const days = fc.sample(fc.shuffledSubarray(Array.from({ length: 40 }, (_, i) => addDays(SUNDAY, i)), { minLength: 40 }), 1)[0]
  for (const through of days)
    await store("laundry", { through })
  await store("buses", { through: SUNDAY })
  expect(await readModel("laundry")).toEqual({ state: { through: days.at(-1) }, revision: expect.any(String) })
  expect(sqlite.prepare("select through from models where name = 'laundry' order by through").all().map(({ through }) => through)).toEqual(days.slice(10).sort())
  expect((await health()).models).toEqual({ buses: SUNDAY, laundry: days.at(-1) })
  await expect(writeModel("laundry", { through: null }, null)).rejects.toThrow("400")
  await expect(writeModel("laundry", { through: SUNDAY }, undefined as unknown as null)).rejects.toThrow("400")
  await expect(writeModel("anything", { through: SUNDAY }, null)).rejects.toThrow("404")
})

test("a model of a new version through an earlier day than the one it replaces is what's read back, kept however old, and only stored over by a writer that read it", async () => {
  for (let i = 0; i < 40; i++)
    await store("buses", { through: addDays(SUNDAY, i), version: "1" })
  const { revision: old } = await readModel("buses")
  await writeModel("buses", { through: SUNDAY, version: "2" }, old!)
  expect(await readModel("buses")).toMatchObject({ state: { through: SUNDAY, version: "2" } })
  expect((await health()).models.buses).toBe(SUNDAY)
  // A writer that read the model before the new version's can't replace it, or store past it
  await expect(writeModel("buses", { through: SUNDAY, version: "1" }, old!)).rejects.toThrow("409")
  await expect(writeModel("buses", { through: addDays(SUNDAY, 40), version: "1" }, old!)).rejects.toThrow("409")
  expect((await readModel("buses")).state).toEqual({ through: SUNDAY, version: "2" })
})

/**
 * Learns a model of a version through a day, as the Inputs workflow does when asked to store, failing to read one day
 * if asked, with the days it folded and what it wrote for the page
 */
const learnThrough = async (version: number, last: Day, { unreadable, store = true, rebuild = false }: { unreadable?: Day, store?: boolean, rebuild?: boolean } = {}) => {
  type Model = { version: number, through: Day | null }
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
    },
    store,
    rebuild
  })
  return { folded, bundled: JSON.parse(await readFile(output, "utf8")) as Model }
}

const daysFrom = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => addDays(SUNDAY, from + i))

test("learning stores every day past the model stored, a day it can't read stopping it there, and the next run carries on from what it stored", async () => {
  expect(await learnThrough(1, addDays(SUNDAY, 18))).toEqual({ folded: daysFrom(0, 18), bundled: { version: 1, through: addDays(SUNDAY, 18) } })
  expect(process.exitCode ?? 0).toBe(0)
  // A new version starts afresh, and is stored however far it gets, since the model of another version is no use to it,
  // but the run fails once it's done, so a day that never folds is seen
  expect(await learnThrough(2, addDays(SUNDAY, 18), { unreadable: addDays(SUNDAY, 11) })).toEqual({ folded: daysFrom(0, 10), bundled: { version: 2, through: addDays(SUNDAY, 10) } })
  expect(process.exitCode).toBe(1)
  process.exitCode = 0
  expect(await learnThrough(2, addDays(SUNDAY, 18))).toEqual({ folded: daysFrom(11, 18), bundled: { version: 2, through: addDays(SUNDAY, 18) } })
  expect(process.exitCode).toBe(0)
  expect(await learnThrough(2, addDays(SUNDAY, 18))).toEqual({ folded: [], bundled: { version: 2, through: addDays(SUNDAY, 18) } })
})

test("a run not asked to store writes the model stored as it is, or an empty one if it's another version's, and stores nothing", async () => {
  await learnThrough(1, addDays(SUNDAY, 3))
  const { revision } = await readModel("buses")
  expect(await learnThrough(1, addDays(SUNDAY, 5), { store: false })).toEqual({ folded: [], bundled: { version: 1, through: addDays(SUNDAY, 3) } })
  expect(await learnThrough(2, addDays(SUNDAY, 5), { store: false })).toEqual({ folded: [], bundled: { version: 2, through: null } })
  expect((await readModel("buses")).revision).toBe(revision)
})

test("a rebuild cut short of the days stored stores nothing, leaving the model stored written, and one that gets there replaces it", async () => {
  await learnThrough(1, addDays(SUNDAY, 18))
  expect(await learnThrough(1, addDays(SUNDAY, 18), { rebuild: true, unreadable: addDays(SUNDAY, 8) })).toEqual({ folded: daysFrom(0, 7), bundled: { version: 1, through: addDays(SUNDAY, 18) } })
  expect((await readModel("buses")).state).toEqual({ version: 1, through: addDays(SUNDAY, 18) })
  expect(await learnThrough(1, addDays(SUNDAY, 19), { rebuild: true })).toEqual({ folded: daysFrom(0, 19), bundled: { version: 1, through: addDays(SUNDAY, 19) } })
})

test("against a Worker that refuses learning's writes, as the one deployed before a change to its API may, what it stores is written as it was", async () => {
  const stored = { version: 1, through: addDays(SUNDAY, 3) }
  const posts: unknown[] = []
  // As the Worker before revisions answers: the latest state alone, and a 400 for a state sent with what it expects
  vi.stubGlobal("fetch", async (_: string, init?: RequestInit) => {
    if (init?.method !== "POST")
      return Response.json({ state: stored })
    posts.push(JSON.parse(`${init.body}`).state.through)
    return new Response(null, { status: 400 })
  })
  expect(await learnThrough(1, addDays(SUNDAY, 6))).toEqual({ folded: daysFrom(4, 6), bundled: stored })
  expect(await learnThrough(2, addDays(SUNDAY, 1))).toEqual({ folded: daysFrom(0, 1), bundled: { version: 2, through: null } })
  expect(posts).toEqual([addDays(SUNDAY, 6), addDays(SUNDAY, 1)])
})

test("without BUILD_TOKEN, a run asked to store fails, and any other writes an empty model", async () => {
  vi.stubEnv("BUILD_TOKEN", "")
  await expect(learnThrough(1, SUNDAY)).rejects.toThrow("BUILD_TOKEN")
  expect(await learnThrough(1, SUNDAY, { store: false })).toEqual({ folded: [], bundled: { version: 1, through: null } })
})

test("a model is only stored over the revision its writer read, so of two builds learning at once the second's 409s, even replacing the same day", async () => {
  await writeModel("buses", { through: SUNDAY, n: 1 }, null)
  // Both read SUNDAY's; the first to store wins, and the other learns that rather than overwriting it
  const { revision: first } = await readModel("buses")
  await writeModel("buses", { through: addDays(SUNDAY, 1), n: 2 }, first!)
  await expect(writeModel("buses", { through: addDays(SUNDAY, 1), n: 3 }, first!)).rejects.toThrow("409")
  await expect(writeModel("buses", { through: addDays(SUNDAY, 2), n: 3 }, null)).rejects.toThrow("409")
  // The same day again, by a build that read it, replaces it, as a rebuild does, under a new revision, so a second
  // writer that read the same day's earlier revision can't replace it too
  const { revision: second } = await readModel("buses")
  expect(second).not.toBe(first)
  await writeModel("buses", { through: addDays(SUNDAY, 1), n: 4 }, second!)
  await expect(writeModel("buses", { through: addDays(SUNDAY, 1), n: 5 }, second!)).rejects.toThrow("409")
  expect(await readModel("buses")).toMatchObject({ state: { through: addDays(SUNDAY, 1), n: 4 } })
})

/** A timetable as a build acquires one: its JSON and zip, and what it says of itself */
const acquire = async (version: string, start = SUNDAY, end = addDays(SUNDAY, 99)) => {
  const json = JSON.stringify({ version, start, end, routes: [], stops: [], services: {}, trips: [], shapes: {} })
  const original = new TextEncoder().encode(`zip of ${version}`)
  const form = new FormData()
  for (const [name, value] of Object.entries({ id: await contentHash(json), source: await contentHash(original), version, start, end }))
    form.set(name, value)
  form.set("feed", new Blob([json]))
  form.set("original", new Blob([original]))
  return (await request<{ acquired: boolean }>("/api/feeds", form)).acquired
}

test("a timetable is acquired when it isn't the one acquired last, kept whole with its zip, and read back by its hash", async () => {
  expect(await acquire("spring")).toBe(true)
  expect(await acquire("spring")).toBe(false)
  expect(await acquire("fall")).toBe(true)
  // Back to the first, it's acquired again after the second
  expect(await acquire("spring")).toBe(true)
  const acquired = await request<Acquisition[]>("/api/feeds")
  expect(acquired.map(({ version }) => version)).toEqual(["spring", "fall", "spring"])
  expect(acquired[0].id).toBe(acquired[2].id)
  expect(await request<{ version: string }>(`/api/feeds/${acquired[1].id}`)).toMatchObject({ version: "fall", start: SUNDAY })
  expect(sqlite.prepare("select original from feeds where version = 'fall'").get()).toEqual({ original: new TextEncoder().encode("zip of fall") })
  await expect(request(`/api/feeds/${"0".repeat(64)}`)).rejects.toThrow("404")
})

test("a day is replayed against the timetable last acquired by its end of those whose own days don't leave it out, else one acquired later whose days name it, and never a made-up one", () =>
  fc.assert(fc.property(fc.array(fc.record({ acquired: fc.integer({ min: -20, max: 20 }), start: fc.option(fc.integer({ min: -30, max: 10 })), end: fc.option(fc.integer({ min: -10, max: 30 })) }), { maxLength: 6 }), fc.integer({ min: -30, max: 30 }), (made, offset) => {
    const day = addDays(SUNDAY, offset)
    const acquired: Acquisition[] = made.map(({ acquired, start, end }, i) => ({
      id: `${i}`, version: `${i}`, acquired: serviceDayStart(addDays(SUNDAY, acquired)) + 3600_000,
      start: start === null ? "" : addDays(SUNDAY, start), end: end === null ? "" : addDays(SUNDAY, end)
    })).sort((a, b) => a.acquired - b.acquired)
    const found = inEffect(acquired, day)
    const covers = ({ start, end }: Acquisition) => (!start || start <= day) && (!end || day <= end)
    const byThen = acquired.filter(feed => covers(feed) && feed.acquired < serviceDayStart(addDays(day, 1)))
    if (byThen.length)
      expect(found).toBe(byThen.at(-1))
    else if (found)
      expect(found.start && found.end && covers(found) && found === acquired.find(feed => feed.start && feed.end && covers(feed))).toBeTruthy()
    else
      expect(acquired.some(feed => feed.start && feed.end && covers(feed))).toBe(false)
  }))
)

test("storage says how big the database is, in bytes and rows a table", async () => {
  await derived("visits", SUNDAY, {}, async () => [1, 2, 3])
  const { bytes, rows } = await storage()
  expect(bytes).toBeGreaterThan(4096)
  expect(rows).toEqual({ samples: 0, derived: 1, chunks: 1, feeds: 0, models: 0, transitions: 0, latest: 0, polls: 0, room_snapshots: 0 })
})

test("health says when each table's rows start and end, in its own unit, and the day each model runs through", async () => {
  const at = Date.parse("2026-10-07T16:00:00Z")
  for (const minutes of [0, 1, 7])
    sqlite.prepare("insert into samples (source, at, body) values ('buses', ?, x'00')").run(at + minutes * 60_000)
  sqlite.prepare("insert into polls (at, failed) values (?, '[]')").run(at)
  expect(await health()).toEqual({
    buses:       { since: at, last: at + 7 * 60_000 },
    predictions: { since: null, last: null },
    transitions: { since: null, last: null },
    polls:       { since: at, last: at },
    models:      { buses: null, laundry: null }
  })
})

test("the nightly prune drops laundry's rows past what it keeps, and what's derived past what each name keeps", async () => {
  const today = "2026-10-07"
  const noon = (days: number) => dayStart(addDays(today, -days)) + 12 * HOUR
  for (const days of [61, 60, 59])
    sqlite.prepare("insert into transitions (machine, room, at, status, raw, remaining) values ('m', 'r', ?, 'free', '', 0)").run(noon(days))
  for (const days of [401, 400, 399, 181, 180, 179])
    for (const name of ["visits", "statistics"])
      await derived(name, addDays(today, -days), {}, async () => days)
  await prune(env, today)
  expect(count("transitions")).toBe(2)
  const kept = (name: string) => sqlite.prepare("select count(*) as n from derived where name = ?").get(name)!.n
  expect([kept("visits"), kept("statistics")]).toEqual([2, 5])
  expect(count("chunks")).toBe(7)
})

test("the nightly prune drops samples past two weeks of days the archive has, and never a day's the archive doesn't, however old", async () => {
  const today = "2026-10-07"
  const noon = (days: number) => serviceDayStart(addDays(today, -days)) + 12 * HOUR
  const ages = [400, 70, 61, 60, 40, 30, 20, 15, 14, 13, 1]
  for (const days of ages)
    for (const source of ["buses", "predictions"])
      sqlite.prepare("insert into samples (source, at, body) values (?, ?, x'00')").run(source, noon(days))
  // Archived: three past the window, and two within it, kept however archived
  await prune(env, today, [70, 40, 20, 14, 1].map(days => addDays(today, -days)))
  const kept = sqlite.prepare("select distinct at from samples order by at").all().map(({ at }) => at)
  expect(kept).toEqual([400, 61, 60, 30, 15, 14, 13, 1].map(noon))
})

test("the samples pruned are the archived days past the window, as spans that meet merged", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: -5, max: 80 })), fc.integer({ min: 1, max: 30 }), (ages, window) => {
    const today = "2026-10-07"
    const spans = archivedSpans(today, ages.map(days => addDays(today, -days)), window)
    const goes = (days: number) => spans.some(([from, to]) => from <= serviceDayStart(addDays(today, -days)) + 12 * HOUR && serviceDayStart(addDays(today, -days)) + 12 * HOUR < to)
    for (let days = -5; days <= 80; days++)
      expect(goes(days)).toBe(ages.includes(days) && days > window)
    for (let i = 1; i < spans.length; i++)
      expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1])
  }))
)

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
    await expect(derived("visits", SUNDAY, {}, async () => [])).rejects.toThrow(/40[01]/)
    await expect(request("/api/feeds")).rejects.toThrow(/40[01]/)
    await expect(readModel("buses")).rejects.toThrow(/40[01]/)
    await expect(writeModel("buses", { version: 1, through: SUNDAY }, null)).rejects.toThrow(/40[01]/)
    await expect(storage()).rejects.toThrow(/40[01]/)
  }
  worker(TOKEN)
  await expect(readRows("nothing")).rejects.toThrow("404")
  await expect(request("/api/rows/transitions", { rows: [] })).rejects.toThrow("404")
  await expect(request("/api/derived/summaries?day=" + SUNDAY)).rejects.toThrow("404")
})
