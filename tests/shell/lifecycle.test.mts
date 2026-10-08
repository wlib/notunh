import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { HOUR, localDay } from "../../src/shared/time.mts"
import { fakePage, leavePage } from "./page.mts"

afterEach(leavePage)

/** A fresh page loaded at a time, with the lifecycle module watching it */
const load = async (at: number, visibilityState: DocumentVisibilityState = "visible") => {
  const page = fakePage({ at, visibilityState })
  return { ...page, ...await import("../../src/shell/lifecycle.mts") }
}

// Through 2026, so across days, daylight saving, and the year
const times = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) })

const steps = fc.array(
  fc.oneof(
    fc.constant({ kind: "hide" as const }),
    fc.constant({ kind: "show" as const }),
    fc.constant({ kind: "restore" as const }),
    fc.record({ kind: fc.constant("wait" as const), ms: fc.oneof(fc.integer({ min: 0, max: 10 * 60_000 }), fc.integer({ min: 0, max: 3 * HOUR })) })
  ),
  { maxLength: 20 }
)

test("coming back reloads after an hour away or on a new day, and otherwise marks when, with no mark while away", async () => {
  await fc.assert(fc.asyncProperty(times, steps, async (loadedAt, steps) => {
    const page = await load(loadedAt)
    let hiddenAt: number | undefined
    let since: number | undefined = loadedAt
    for (const step of steps) {
      if (step.kind === "wait") {
        await vi.advanceTimersByTimeAsync(step.ms)
        continue
      }
      if (step.kind === "hide") {
        page.setVisibility("hidden")
        hiddenAt ??= Date.now()
        since = undefined
      }
      else {
        if (step.kind === "show")
          page.setVisibility("visible")
        else
          page.restore()
        if (hiddenAt !== undefined) {
          const isLongAway = Date.now() - hiddenAt >= HOUR || localDay(Date.now()) !== localDay(loadedAt)
          hiddenAt = undefined
          if (isLongAway) {
            expect(page.reload).toHaveBeenCalledTimes(1)
            return
          }
          since = Date.now()
        }
      }
      expect(page.reload).not.toHaveBeenCalled()
      expect(page.visibleSince.peek()).toBe(since)
      expect(page.isVisible.peek()).toBe(since !== undefined)
    }
  }))
})

test("the clock ticks every 15 s and on coming back, and today follows it, reaching dependents only on a new day", async () => {
  await fc.assert(fc.asyncProperty(times, steps, async (loadedAt, steps) => {
    const page = await load(loadedAt)
    const { watch } = await import("bruh/reactive")
    const days: string[] = []
    watch([page.today], () => void days.push(page.today.value))
    await vi.advanceTimersByTimeAsync(0)
    for (const step of steps) {
      if (step.kind === "wait")
        await vi.advanceTimersByTimeAsync(step.ms)
      else {
        if (step.kind === "restore")
          page.restore()
        else
          page.setVisibility(step.kind === "hide" ? "hidden" : "visible")
        await vi.advanceTimersByTimeAsync(0)
        if (page.reload.mock.calls.length)
          return
      }
      const now = page.now.peek()
      expect(Date.now() - now).toBeGreaterThanOrEqual(0)
      expect(Date.now() - now).toBeLessThan(page.TICK_MS)
      // Just back, the clock says so at once
      if (page.visibleSince.peek() === Date.now())
        expect(now).toBe(Date.now())
      expect(page.today.peek()).toBe(localDay(now))
      expect(days.at(-1)).toBe(localDay(now))
      expect(days.every((day, i) => i === 0 || day !== days[i - 1])).toBe(true)
    }
  }))
})

test("a page loaded out of view counts as away since it loaded", async () => {
  const loadedAt = Date.UTC(2026, 9, 7, 16)
  const page = await load(loadedAt, "hidden")
  expect(page.visibleSince.peek()).toBeUndefined()
  expect(page.isVisible.peek()).toBe(false)
  vi.advanceTimersByTime(HOUR)
  page.setVisibility("visible")
  expect(page.reload).toHaveBeenCalledTimes(1)

  const brief = await load(loadedAt, "hidden")
  vi.advanceTimersByTime(60_000)
  brief.setVisibility("visible")
  expect(brief.reload).not.toHaveBeenCalled()
  expect(brief.visibleSince.peek()).toBe(loadedAt + 60_000)
  expect(brief.isVisible.peek()).toBe(true)
})

test("pageshow after the visibility event already brought the page back changes nothing", async () => {
  const loadedAt = Date.UTC(2026, 9, 7, 16)
  const page = await load(loadedAt)
  page.setVisibility("hidden")
  vi.advanceTimersByTime(30_000)
  page.setVisibility("visible")
  vi.advanceTimersByTime(5_000)
  page.restore()
  expect(page.visibleSince.peek()).toBe(loadedAt + 30_000)
  expect(page.reload).not.toHaveBeenCalled()
})
