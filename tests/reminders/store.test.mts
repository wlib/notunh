import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import { type Kept, STATES } from "../../src/reminders/reminder.mts"
import { CACHE, device, deviceKept, forget, forgetAll, keep, reminderOf, reminders, transition } from "../../src/reminders/browser/store.mts"
import { browserStorage } from "./browser.mts"

const NOW = 1_790_000_000
let storage: ReturnType<typeof browserStorage>

beforeEach(() => {
  storage = browserStorage()
  vi.stubGlobal("caches", storage.caches)
  vi.stubGlobal("navigator", { locks: storage.locks })
})

afterEach(() => vi.unstubAllGlobals())

const kept = (id: string, state: Kept["state"] = "set"): Kept => ({
  id, from: { lat: 43.13, lon: -70.93, name: "Here" }, to: { lat: 43.14, lon: -70.94, name: "MUB" }, way: "w",
  legs: [{ kind: "walk", walk: 240, to: "Kingsbury Hall" }, { kind: "ride", trip: "t", route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW, expected: NOW, isLive: true }, { kind: "walk", walk: 60, to: "MUB" }],
  start: NOW - 300, end: NOW + 900, headsUp: 300, state
})

test("two tabs asking for the device at once, as when each sets its first reminder, get the one device, kept as one JSON entry in a cache of its own", async () => {
  expect(await deviceKept()).toBeUndefined()
  const [a, b] = await Promise.all([device(), device()])
  expect(a).toEqual(b)
  expect(a.id).toMatch(/^[\w-]{22}$/)
  expect(a.secret).toMatch(/^[\w-]{43}$/)
  expect(await device()).toEqual(a)
  expect([...storage.entriesOf(CACHE).keys()]).toEqual(["/reminders.json"])
  expect(storage.entriesOf(CACHE).get("/reminders.json")).toEqual({ version: 2, device: a, reminders: [] })
})

test("whatever tabs do at once, what's kept is what the last word on each reminder says, and a reminder kept reads back whole", async () => {
  const op = fc.oneof(
    fc.record({ kind: fc.constant("keep" as const), id: fc.constantFrom("r1", "r2", "r3"), state: fc.constantFrom(...STATES) }),
    fc.record({ kind: fc.constant("forget" as const), id: fc.constantFrom("r1", "r2", "r3") }),
    fc.record({ kind: fc.constant("forgetAll" as const) })
  )
  await fc.assert(fc.asyncProperty(fc.array(fc.array(op, { minLength: 1, maxLength: 4 }), { maxLength: 10 }), async batches => {
    storage = browserStorage()
    vi.stubGlobal("caches", storage.caches)
    vi.stubGlobal("navigator", { locks: storage.locks })
    const model = new Map<string, Kept>()
    for (const batch of batches) {
      // Each batch is tabs acting at once, which the lock takes in the order they asked
      await Promise.all(batch.map(op => {
        if (op.kind === "keep") {
          model.set(op.id, kept(op.id, op.state))
          return keep(kept(op.id, op.state))
        }
        if (op.kind === "forget") {
          model.delete(op.id)
          return forget(op.id)
        }
        model.clear()
        return forgetAll()
      }))
      expect(new Map((await reminders()).map(reminder => [reminder.id, reminder]))).toEqual(model)
    }
    for (const [id, reminder] of model)
      expect(await reminderOf(id)).toEqual(reminder)
    expect(await reminderOf("r4")).toBeUndefined()
  }), { numRuns: 40 })
})

test("storage that fails rejects reading and keeping alike, and an entry of another version reads as nothing", async () => {
  await keep(kept("r1"))
  storage.setFailing(true)
  await expect(reminders()).rejects.toThrow()
  await expect(deviceKept()).rejects.toThrow()
  await expect(keep(kept("r2"))).rejects.toThrow()
  storage.setFailing(false)
  expect(await reminders()).toEqual([kept("r1")])
  // Another version keeps only its device, whose Worker object still holds the old watches, to end them with
  const made = await device()
  await (await storage.caches.open(CACHE)).put("/reminders.json", new Response(JSON.stringify({ version: 1, device: made, reminders: [kept("r1")] })))
  expect(await reminders()).toEqual([])
  expect(await deviceKept()).toEqual(made)
  await (await storage.caches.open(CACHE)).put("/reminders.json", new Response(JSON.stringify({ version: 1, reminders: [kept("r1")] })))
  expect(await deviceKept()).toBeUndefined()
})

test("a transition only moves a reminder still in the state it names, so a cancel during setting stays cancelled", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...STATES), fc.constantFrom(...STATES), fc.constantFrom(...STATES), async (was, from, to) => {
    storage = browserStorage()
    vi.stubGlobal("caches", storage.caches)
    vi.stubGlobal("navigator", { locks: storage.locks })
    await keep(kept("r1", was))
    expect(await transition("r1", from, to)).toEqual([kept("r1", was === from ? to : was)])
    expect(await transition("r2", from, to)).toEqual([kept("r1", was === from ? to : was)])
  }), { numRuns: 27 })
  // The Worker takes a reminder while the phone cancels it: the Worker's answer doesn't undo the cancel
  await keep(kept("r1", "setting"))
  await Promise.all([keep(kept("r1", "cancelling")), transition("r1", "setting", "set")])
  expect(await reminders()).toEqual([kept("r1", "cancelling")])
})

test("a read that fails rejects the change, and nothing is written over what was kept", async () => {
  await keep(kept("r1"))
  const before = storage.entriesOf(CACHE).get("/reminders.json")
  storage.setFailing(true)
  await expect(forget("r1")).rejects.toThrow()
  await expect(forgetAll()).rejects.toThrow()
  await expect(device()).rejects.toThrow()
  await expect(transition("r1", "set", "cancelling")).rejects.toThrow()
  storage.setFailing(false)
  expect(storage.entriesOf(CACHE).get("/reminders.json")).toEqual(before)
  expect(await reminders()).toEqual([kept("r1")])
})
