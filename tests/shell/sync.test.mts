// Your things across linked devices that run different releases, as they do for as long as one hasn't reloaded: each
// device is a page of its own storage and its own code's format of a key (src/shell/state.mts), exchanging with one
// Worker as src/shell/sync.mts does. Whatever each writes and whenever each asks, what newer code wrote is never
// written over by older code, on a device or on the Worker, older code holds it whole without reading it, and
// everyone ends holding what the Worker keeps

import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { type Format, format, read, readKept, versionOf } from "../../src/shared/format.mts"
import { type Entries, isNewer, stillPending, toTake } from "../../src/shared/sync.mts"
import { fakePage, leavePage } from "./page.mts"

afterEach(leavePage)

const KEY = "courses-saved"
const START = Date.UTC(2026, 9, 7, 16)

type Saved = string[] | { version: number, keys: string[], marks: number[] }

const readList = (stored: unknown): string[] =>
  Array.isArray(stored) ? stored.filter(item => typeof item === "string") : []

/** The key's format as a release has it: a bare list at first, then versions that each upgrade the one before */
const formatOf = (code: number): Format<Saved> => code === 0 ? format<Saved>(readList) : {
  version:  code,
  schema:   v.object({ version: v.literal(code), keys: v.array(v.string()), marks: v.array(v.number()) }),
  upgrades: [
    older => ({ version: 1, keys: readList(older), marks: [] }),
    ...Array.from({ length: code - 1 }, (_, i) => (older: unknown) => ({ ...Object(older), version: i + 2, marks: [...Object(older).marks, i + 2] }))
  ]
}

/** What a release writes for some keys */
const savedBy = (code: number, keys: string[]): Saved =>
  code ? { version: code, keys, marks: Array.from({ length: code - 1 }, (_, i) => i + 2) } : keys

const keysOf = (saved: Saved) =>
  Array.isArray(saved) ? saved : saved.keys

type Device = { code: number, storage: Record<string, string> }

const rawOf = (storage: Record<string, string>): unknown =>
  JSON.parse(storage[KEY] ?? "null")

const op = fc.record({
  device: fc.nat(2),
  /** What it saves, if anything, before or after it asks, if it asks */
  writes: fc.option(fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 3 }), { nil: undefined }),
  asks:   fc.constantFrom("no", "after", "before"),
  tick:   fc.integer({ min: 1, max: 5 })
})

test("linked devices on different releases settle on what the Worker keeps, older code never writing over what newer code wrote, and holding it whole", () =>
  fc.assert(fc.asyncProperty(fc.array(fc.nat(2), { minLength: 3, maxLength: 3 }), fc.array(op, { maxLength: 12 }), async (codes, ops) => {
    let now = START
    const worker: Entries = {}
    const devices: Device[] = codes.map(code => ({ code, storage: {} }))

    /** A device's page opened, as a visit is, to write, to ask the Worker, or both */
    const visit = async (device: Device, writes: string[] | undefined, asks: string) => {
      const before = rawOf(device.storage)
      const page = fakePage({ at: now, saved: device.storage })
      const state = await import("../../src/shell/state.mts")
      const value = state.remembered(KEY, formatOf(device.code))
      await vi.advanceTimersByTimeAsync(0)
      // Reading is no write: what's there stays as it was, and reads as its upgrade, or as nothing if it's newer
      expect(rawOf(Object.fromEntries(page.storage))).toEqual(before)
      expect(value.peek()).toEqual(readKept(formatOf(device.code), before))

      const write = async () => {
        if (!writes)
          return
        const held = rawOf(Object.fromEntries(page.storage))
        value.value = savedBy(device.code, writes)
        await vi.advanceTimersByTimeAsync(0)
        // What newer code wrote is left exactly as it is, and the write isn't sent
        if (versionOf(held) > device.code) {
          expect(rawOf(Object.fromEntries(page.storage))).toEqual(held)
          expect(state.pendingEntries()[KEY]?.value).toEqual(state.syncing().pending.includes(KEY) ? held : undefined)
        }
        else
          expect(readKept(formatOf(device.code), rawOf(Object.fromEntries(page.storage)))).toEqual(savedBy(device.code, writes))
      }

      /** One exchange, as src/shell/sync.mts makes it, with the Worker keeping the newer and clamping to its clock */
      const ask = () => {
        const sent = state.pendingEntries()
        for (const entry of Object.values(sent)) {
          const clamped = { ...entry, at: Math.min(entry.at, now) }
          if (isNewer(clamped, worker[KEY])) {
            expect(versionOf(clamped.value)).toBeGreaterThanOrEqual(versionOf(worker[KEY]?.value))
            worker[KEY] = clamped
          }
        }
        const { stamps, pending } = state.syncing()
        const still = stillPending(pending, sent, stamps)
        state.take(toTake(stamps, structuredClone(worker), still), still)
      }

      if (asks === "after")
        await write()
      if (asks !== "no")
        ask()
      if (asks !== "after")
        await write()
      await vi.advanceTimersByTimeAsync(0)
      // What a device holds never goes back a version
      expect(versionOf(rawOf(Object.fromEntries(page.storage)))).toBeGreaterThanOrEqual(versionOf(before))
      device.storage = Object.fromEntries(page.storage)
    }

    for (const { device, writes, asks, tick } of ops) {
      now += tick * 1000
      await visit(devices[device], writes, asks)
    }
    // Everyone asks twice more, writing nothing: once to send, once to hear the rest
    for (let round = 0; round < 2; round++)
      for (const device of devices) {
        now += 1000
        await visit(device, undefined, "before")
      }

    const newest = formatOf(2)
    for (const device of devices) {
      const held = rawOf(device.storage)
      expect(JSON.parse(device.storage.sync ?? "{}").pending ?? []).toEqual([])
      // Each holds what the Worker keeps, whole, whether or not its code reads it
      expect(held).toEqual(worker[KEY]?.value ?? null)
      const found = read(formatOf(device.code), held)
      if (versionOf(held) > device.code)
        expect(found).toEqual({ newer: versionOf(held) })
      else
        expect("value" in found && keysOf(found.value)).toEqual(keysOf(readKept(newest, held)))
    }
  }))
)

test("a tab on older code neither reads nor writes over what a tab on newer code kept since it loaded, and newer code reads what older code kept as its upgrade", async () => {
  const page = fakePage({ at: START, saved: { [KEY]: JSON.stringify(["a"]) } })
  const state = await import("../../src/shell/state.mts")
  const old = state.remembered(KEY, formatOf(0))
  expect(old.peek()).toEqual(["a"])
  expect(state.syncing().stamps[KEY]?.at).toBe(0)
  // Another tab, on the next release, saves one more
  const newer = savedBy(1, ["a", "b"])
  page.storage.set(KEY, JSON.stringify(newer))
  old.value = ["a", "c"]
  await vi.advanceTimersByTimeAsync(0)
  expect(JSON.parse(page.storage.get(KEY)!)).toEqual(newer)
  // Its write isn't stamped, so what's sent of the key is what the newer tab kept, as it kept it
  expect(state.syncing().stamps[KEY]?.at).toBe(0)
  expect(state.pendingEntries()[KEY]?.value).toEqual(newer)
  expect(state.stored(KEY)).toBeNull()
  expect(state.store(KEY, ["x"])).toBe(false)
  // What's taken from another device on newer code is held as it came, and what the tab shows stays its own
  const taken = savedBy(2, ["z"])
  state.take({ [KEY]: { at: 5, by: "other", value: taken } }, [])
  await vi.advanceTimersByTimeAsync(0)
  expect(old.peek()).toEqual(["a", "c"])
  expect(JSON.parse(page.storage.get(KEY)!)).toEqual(taken)
  page.storage.set(KEY, JSON.stringify(newer))

  // The next release's code reads it, and a release after that upgrades it, kept as it was until it's changed
  fakePage({ at: START, saved: Object.fromEntries(page.storage) })
  const later = await import("../../src/shell/state.mts")
  expect(later.remembered(KEY, formatOf(1)).peek()).toEqual(newer)
  const again = fakePage({ at: START, saved: Object.fromEntries(page.storage) })
  const latest = await import("../../src/shell/state.mts")
  const saved = latest.remembered(KEY, formatOf(2))
  await vi.advanceTimersByTimeAsync(0)
  expect(saved.peek()).toEqual(savedBy(2, ["a", "b"]))
  expect(JSON.parse(again.storage.get(KEY)!)).toEqual(newer)
  saved.value = savedBy(2, ["b"])
  await vi.advanceTimersByTimeAsync(0)
  expect(JSON.parse(again.storage.get(KEY)!)).toEqual(savedBy(2, ["b"]))
  expect(latest.syncing().pending).toEqual([KEY])
})
