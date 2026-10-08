import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { fakePage, leavePage } from "./page.mts"

afterEach(leavePage)

const NOON = Date.UTC(2026, 9, 7, 16)

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

const readList = (stored: unknown) =>
  Array.isArray(stored) && stored.every(item => typeof item === "string") ? stored : []

test("a remembered value comes back on the next visit as it was left, and anything else stored reads as the default", async () => {
  await fc.assert(fc.asyncProperty(
    fc.oneof(fc.string(), fc.json(), fc.constant("[1, 2")),
    fc.array(fc.array(fc.string(), { maxLength: 4 }), { maxLength: 5 }),
    async (garbage, values) => {
      const first = fakePage({ at: NOON, saved: { list: garbage } })
      const { remembered } = await import("../../src/shell/state.mts")
      const list = remembered("list", readList)
      expect(list.peek()).toEqual(readList(parsed(garbage)))
      for (const value of values)
        list.value = value
      await vi.advanceTimersByTimeAsync(0)

      fakePage({ at: NOON, saved: Object.fromEntries(first.storage) })
      const again = await import("../../src/shell/state.mts")
      expect(again.remembered("list", readList).peek()).toEqual(values.at(-1) ?? list.peek())
    }
  ))
})

test("storage that throws, as in private browsing, reads as nothing stored and writes nowhere", async () => {
  fakePage({ at: NOON })
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("full") } })
  const { remembered, stored, store } = await import("../../src/shell/state.mts")
  expect(stored("list")).toBeNull()
  expect(() => store("list", ["a"])).not.toThrow()
  const list = remembered("list", readList)
  list.value = ["a"]
  await vi.advanceTimersByTimeAsync(0)
  expect(list.peek()).toEqual(["a"])
})

test("a distinct value reaches its dependents only when it changes, however often what it follows does", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.array(fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 2 }), { minLength: 1, maxLength: 3 }), { maxLength: 10 }),
    async ticks => {
      fakePage({ at: NOON })
      const { r, watch } = await import("bruh/reactive")
      const { distinct, isSameList } = await import("../../src/shell/state.mts")
      const source = r<number[]>([])
      const list = distinct(() => [...source.value], isSameList)
      const seen: number[][] = []
      watch([list], () => void seen.push(list.value))
      await vi.advanceTimersByTimeAsync(0)
      const expected: number[][] = [[]]
      // Each tick sets the source some times over before effects run
      for (const values of ticks) {
        for (const value of values)
          source.value = value
        await vi.advanceTimersByTimeAsync(0)
        if (!isSameList(values.at(-1)!, expected.at(-1)!))
          expected.push(values.at(-1)!)
      }
      expect(seen).toEqual(expected)
    }
  ))
})

test("toggling adds what's missing and takes out what's there, and twice is the same set again", async () => {
  const { toggled, isSameSet } = await import("../../src/shell/state.mts")
  fc.assert(fc.property(fc.uniqueArray(fc.nat({ max: 9 })), fc.nat({ max: 9 }), (items, item) => {
    const set = new Set(items)
    expect(toggled(set, item).has(item)).toBe(!set.has(item))
    expect(isSameSet(toggled(toggled(set, item), item), set)).toBe(true)
    expect(set).toEqual(new Set(items))
  }))
})
