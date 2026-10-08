import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import type { Vehicle } from "../../src/map/umo.mts"
import { decode, unpackFixes, type RawFix } from "../../src/map/raw.mts"
import { sampling, type Env, type Source } from "../../worker/collect.mts"
import { POLLS, buses } from "../../worker/buses.mts"
import { d1 } from "./d1.mts"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The start of a minute
const AT = 1_791_360_000_000

const vehicle = (id: string, gpsTime: number, secsSinceReport = 5): Vehicle => ({
  id, gpsTime, secsSinceReport,
  lat: 43.13, lon: -70.93, heading: 90, kph: 20, predictable: true,
  route: { id: "Gables", name: "Gables" }, dir: null
})

// What one poll gets: some buses' latest fixes, a rate limit, or a body that isn't a vehicle list
const reply = fc.oneof(
  { weight: 4, arbitrary: fc.array(fc.record({ id: fc.constantFrom("T-51", "T-53", "T-60"), report: fc.integer({ min: 0, max: 5 }), isParked: fc.boolean() }), { maxLength: 4 }) },
  { weight: 1, arbitrary: fc.constantFrom(429, "{\"error\": true}", "<html>") }
)

const serve = (reply: number | string | { id: string, report: number, isParked: boolean }[]) =>
  typeof reply === "number" ? new Response("", { status: reply })
  : typeof reply === "string" ? new Response(reply)
  : Response.json(reply.map(({ id, report, isParked }) => vehicle(id, AT + report * 11_000, isParked ? 3600 : 5)))

test("the buses source stores every distinct fresh fix once, through rate limits and garbage, within the minute", async () =>
  fc.assert(fc.asyncProperty(fc.array(reply, { minLength: POLLS, maxLength: POLLS }), async replies => {
    vi.useFakeTimers({ now: AT })
    let poll = 0
    vi.stubGlobal("fetch", async () => serve(replies[poll++]))

    const fixes = buses.collect(AT, new AbortController().signal)
    await vi.runAllTimersAsync()
    const stored = unpackFixes(AT, await fixes)

    expect(poll).toBe(POLLS)
    expect(Date.now() - AT).toBeLessThan(60_000)
    const expected = new Set(
      replies.flatMap(reply => Array.isArray(reply) ? reply.filter(({ isParked }) => !isParked).map(({ id, report }) => `${id} ${report}`) : [])
    )
    const keys = stored.map(fix => `${fix.vehicle} ${(fix.at - AT) / 11_000}`)
    expect(keys).toHaveLength(new Set(keys).size)
    expect(new Set(keys)).toEqual(expected)
  }))
)

test("sampling a source stores one gzipped row of what it saw, and none when it saw nothing", async () => {
  const db = d1()
  const env = { DB: db } as unknown as Env
  const source = (name: string, samples: () => Promise<RawFix[]>): Source => ({ name, cron: "* * * * *", collect: samples })
  const fix: RawFix = ["T-51", 3, 43.13, -70.93, 90, 20, null, "Gables", null]
  const signal = new AbortController().signal

  await sampling(source("seen", async () => [fix])).run(env, AT, signal)
  await sampling(source("empty", async () => [])).run(env, AT, signal)
  await expect(sampling(source("failed", async () => { throw new Error("upstream down") })).run(env, AT, signal)).rejects.toThrow("upstream down")

  const rows = db.sqlite.prepare("SELECT source, at, body FROM samples").all()
  expect(rows.map(({ source, at }) => [source, at])).toEqual([["seen", AT]])
  expect(await decode(new Uint8Array(rows[0].body as Uint8Array))).toEqual([fix])
})
