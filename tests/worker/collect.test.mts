import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import type { Vehicle } from "../../src/transit/observations/umo.mts"
import { RAW_VERSION, decode, packPoll, unpackFixes, type RawFix } from "../../src/transit/observations/raw.mts"
import { sampling, type Env, type Source } from "../../worker/collect.mts"
import { POLLS, buses } from "../../worker/buses.mts"
import { predictions } from "../../worker/predictions.mts"
import { d1 } from "./d1.mts"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The start of a minute
const AT = 1_791_360_000_000

const vehicle = (id: string, gpsTime: number, secsSinceReport = 5): Vehicle => ({
  id, gpsTime, secsSinceReport,
  lat: 43.13, lon: -70.93, heading: 90, kph: 20,
  route: { id: "Gables" }, dir: null
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

test("the buses source stores every distinct fresh fix once, through rate limits and garbage, within the minute, and records every poll", async () =>
  fc.assert(fc.asyncProperty(fc.array(reply, { minLength: POLLS, maxLength: POLLS }), async replies => {
    vi.useFakeTimers({ now: AT })
    let poll = 0
    vi.stubGlobal("fetch", async () => serve(replies[poll++]))

    const collected = buses.collect(AT, new AbortController().signal)
    await vi.runAllTimersAsync()
    const { samples, polls } = await collected
    const stored = unpackFixes(AT, { version: RAW_VERSION, samples, polls })

    expect(poll).toBe(POLLS)
    // Each poll ten seconds after the one before, failed where the reply wasn't a list, else counting the live buses
    expect(polls).toEqual(replies.map((reply, i) =>
      packPoll(AT, AT + i * 10_000, Array.isArray(reply) ? reply.filter(({ isParked }) => !isParked).length : null)
    ))
    // A fix is received by the first poll that listed it
    for (const fix of stored) {
      const first = replies.findIndex(reply => Array.isArray(reply) && reply.some(({ id, report, isParked }) => !isParked && id === fix.vehicle && AT + report * 11_000 === fix.at))
      expect(fix.received).toBe(AT + first * 10_000)
    }
    expect(Date.now() - AT).toBeLessThan(60_000)
    const expected = new Set(
      replies.flatMap(reply => Array.isArray(reply) ? reply.filter(({ isParked }) => !isParked).map(({ id, report }) => `${id} ${report}`) : [])
    )
    const keys = stored.map(fix => `${fix.vehicle} ${(fix.at - AT) / 11_000}`)
    expect(keys).toHaveLength(new Set(keys).size)
    expect(new Set(keys)).toEqual(expected)
  }))
)

test("sampling a source stores one gzipped row of what it saw and its polls for every minute it polled, seeing nothing or failing too, and none when it made no polls", async () => {
  const db = d1()
  const env = { DB: db } as unknown as Env
  const source = (name: string, collect: Source["collect"]): Source => ({ name, cron: "* * * * *", collect })
  const fix: RawFix = ["T-51", 3, 43.13, -70.93, 90, 20, null, "Gables", null, 0]
  const signal = new AbortController().signal

  await sampling(source("seen", async () => ({ samples: [fix], polls: [packPoll(AT, AT, 1)] }))).run(env, AT, signal)
  await sampling(source("nothing out", async () => ({ samples: [], polls: [packPoll(AT, AT, 0)] }))).run(env, AT, signal)
  await sampling(source("failed", async () => ({ samples: [], polls: [packPoll(AT, AT, null)] }))).run(env, AT, signal)
  await sampling(source("never polled", async () => ({ samples: [], polls: [] }))).run(env, AT, signal)
  await expect(sampling(source("broken", async () => { throw new Error("a bug") })).run(env, AT, signal)).rejects.toThrow("a bug")

  const rows = db.sqlite.prepare("SELECT source, at, body FROM samples ORDER BY rowid").all()
  expect(rows.map(({ source, at }) => [source, at])).toEqual([["seen", AT], ["nothing out", AT], ["failed", AT]])
  expect(await Promise.all(rows.map(({ body }) => decode(new Uint8Array(body as Uint8Array))))).toEqual([
    { version: RAW_VERSION, samples: [fix], polls: [[0, 1]] },
    { version: RAW_VERSION, samples: [], polls: [[0, 0]] },
    { version: RAW_VERSION, samples: [], polls: [[0, null]] }
  ])
})

test("the predictions source records its round as one poll, failed if any request failed, and still a row", async () => {
  vi.useFakeTimers({ now: AT })
  vi.stubGlobal("fetch", async () => new Response("", { status: 503 }))
  expect(await predictions.collect(AT, new AbortController().signal)).toEqual({ samples: [], polls: [[0, null]] })
  vi.stubGlobal("fetch", async () => Response.json([vehicle("T-51", AT, 3600)]))
  expect(await predictions.collect(AT, new AbortController().signal)).toEqual({ samples: [], polls: [[0, 0]] })
})
