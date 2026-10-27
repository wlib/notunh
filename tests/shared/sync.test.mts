// Your things kept for you (src/shared/sync.mts): the newer write of each key wins, the same whichever order writes are
// heard in, and devices that write offline, with clocks that disagree, and keep writing while they ask, all settle on
// what the Worker keeps once each has asked again

import { test, expect } from "vitest"
import fc from "fast-check"
import { type Entries, type Entry, type Key, type Stamp, SYNCED, isNewer, merged, stillPending, toTake } from "../../src/shared/sync.mts"

const key = fc.constantFrom(...SYNCED)
const stamp = fc.record({ at: fc.integer({ min: 0, max: 50 }), by: fc.constantFrom("a", "b", "c") })
// A stamp is one write, so one value: the same stamp twice is the same write
const entry = stamp.map(({ at, by }) => ({ at, by, value: { [by]: at } }))
const entries = fc.dictionary(key, entry).map(found => found as Entries)

test("merging keeps each key's newer write, whatever the order or grouping, and merging again changes nothing", () =>
  fc.assert(fc.property(entries, entries, entries, (a, b, c) => {
    expect(merged(a, b)).toEqual(merged(b, a))
    expect(merged(merged(a, b), c)).toEqual(merged(a, merged(b, c)))
    expect(merged(a, a)).toEqual(a)
    for (const name of SYNCED) {
      const kept = merged(a, b)[name]
      expect(kept).toBe([a[name], b[name]].filter(found => found !== undefined).reduce<Entry | undefined>((x, y) => isNewer(y!, x) ? y : x, undefined))
    }
  }))
)

test("of two stamps one is newer unless they're the same, so every device and the Worker order writes alike", () =>
  fc.assert(fc.property(stamp, stamp, (a: Stamp, b: Stamp) => {
    if (a.at === b.at && a.by === b.by)
      expect(isNewer(a, b) || isNewer(b, a)).toBe(false)
    else
      expect(isNewer(a, b)).toBe(!isNewer(b, a))
  }))
)

type Device = { by: string, skew: number, values: Partial<Record<Key, unknown>>, stamps: Partial<Record<Key, Stamp>>, pending: Key[] }

const op = fc.oneof(
  fc.record({ kind: fc.constant("write" as const), device: fc.nat(2), key, value: fc.integer(), tick: fc.nat(5) }),
  fc.record({ kind: fc.constant("ask" as const), device: fc.nat(2), during: fc.option(fc.record({ key, value: fc.integer() }), { nil: undefined }), tick: fc.nat(5) })
)

test("devices writing offline, with clocks ahead or behind, and writing while they ask, all end with what the Worker keeps, each key its newest write", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 3, maxLength: 3 }), fc.array(op, { maxLength: 40 }), (skews, ops) => {
    let now = 100
    const kept: Entries = {}
    /** Every entry the Worker took, as clamped to its clock */
    const heard: Entry[][] = SYNCED.map(() => [])
    const devices: Device[] = skews.map((skew, i) => ({ by: `d${i}`, skew, values: {}, stamps: {}, pending: [] }))

    const write = (device: Device, name: Key, value: unknown) => {
      const at = Math.max(now + device.skew, (device.stamps[name]?.at ?? 0) + 1)
      device.values[name] = value
      device.stamps[name] = { at, by: device.by }
      device.pending = [...new Set([...device.pending, name])]
    }

    /** One exchange: what's pending sent, the Worker keeping the newer, a write meanwhile, and the answer taken */
    const ask = (device: Device, during?: { key: Key, value: unknown }) => {
      const sent: Entries = Object.fromEntries(device.pending.map(name => [name, { ...device.stamps[name]!, value: device.values[name] }]))
      for (const [name, found] of Object.entries(sent) as [Key, Entry][]) {
        const clamped = { ...found, at: Math.min(found.at, now) }
        heard[SYNCED.indexOf(name)].push(clamped)
        if (isNewer(clamped, kept[name]))
          kept[name] = clamped
      }
      const answer = structuredClone(kept)
      if (during)
        write(device, during.key, during.value)
      const still = stillPending(device.pending, sent, device.stamps)
      for (const [name, taken] of Object.entries(toTake(device.stamps, answer, still)) as [Key, Entry][]) {
        device.values[name] = taken.value
        device.stamps[name] = { at: taken.at, by: taken.by }
      }
      device.pending = still
      // A write made while asking is neither lost nor taken as sent
      if (during) {
        expect(device.values[during.key]).toBe(during.value)
        expect(device.pending).toContain(during.key)
      }
    }

    for (const step of ops) {
      now += step.tick
      if (step.kind === "write")
        write(devices[step.device], step.key, step.value)
      else
        ask(devices[step.device], step.during)
    }
    // Everyone asks twice more, writing nothing: once to send, once to hear the rest
    for (let round = 0; round < 2; round++)
      for (const device of devices) {
        now += 1
        ask(device)
      }

    for (const device of devices) {
      expect(device.pending).toEqual([])
      for (const name of SYNCED)
        expect(device.values[name]).toEqual(kept[name]?.value)
    }
    // What the Worker keeps is the newest of all it heard, whatever order it heard them in
    SYNCED.forEach((name, i) =>
      expect(kept[name]).toEqual(heard[i].reduce<Entry | undefined>((x, y) => isNewer(y, x) ? y : x, undefined)))
  }))
)
