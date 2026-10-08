import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { HOUR } from "../../src/shared/time.mts"
import { fakePage, leavePage } from "./page.mts"

const INTERVAL = 5_000

afterEach(leavePage)

/** A fresh page at noon in Durham, so nothing here comes back on a new day or reloads for it */
const load = async () => {
  const page = fakePage({ at: Date.UTC(2026, 9, 7, 16) })
  return { ...page, ...await import("../../src/shell/poll.mts") }
}

/** Every request poll makes, answering after its delay or never, and given up on when cancelled, as fetch is */
const requests = (delays: (number | undefined)[]) => {
  const made: { signal: AbortSignal, isSettled: boolean, wasVisible: boolean }[] = []
  const f = (signal: AbortSignal) => {
    const request = { signal, isSettled: false, wasVisible: document.visibilityState === "visible" }
    made.push(request)
    const delay = delays[(made.length - 1) % delays.length]
    return new Promise<void>((resolve, reject) => {
      const settle = (f: () => void) => {
        if (request.isSettled)
          return
        request.isSettled = true
        f()
      }
      signal.addEventListener("abort", () => settle(() => reject(signal.reason)))
      if (delay !== undefined)
        setTimeout(() => settle(resolve), delay)
    })
  }
  const inFlight = () => made.filter(request => !request.isSettled)
  return { made, f, inFlight }
}

const steps = fc.array(
  fc.oneof(
    fc.constant({ kind: "visible" as const }),
    fc.constant({ kind: "hidden" as const }),
    fc.record({ kind: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 4 * INTERVAL }) })
  ),
  { maxLength: 30 }
)
const delays = fc.array(fc.option(fc.integer({ min: 0, max: 3 * INTERVAL }), { nil: undefined }), { minLength: 1, maxLength: 5 })

test("poll keeps one request in flight at most, only while visible, cancelling on hide and asking again on coming back", async () => {
  await fc.assert(fc.asyncProperty(steps, delays, async (steps, delays) => {
    const { poll, setVisibility } = await load()
    const { made, f, inFlight } = requests(delays)
    const stop = poll(f, INTERVAL, () => {})
    try {
      expect(made).toHaveLength(1)
      let isHidden = false
      for (const step of steps) {
        const wasHidden = isHidden
        const count = made.length
        if (step.kind === "wait")
          await vi.advanceTimersByTimeAsync(step.ms)
        else {
          setVisibility(step.kind)
          isHidden = step.kind === "hidden"
          await vi.advanceTimersByTimeAsync(0)
        }
        expect(inFlight().length).toBeLessThanOrEqual(1)
        expect(made.every(request => request.wasVisible)).toBe(true)
        if (step.kind === "hidden")
          expect(inFlight()).toHaveLength(0)
        if (step.kind === "visible" && wasHidden)
          expect(made).toHaveLength(count + 1)
      }
    }
    finally {
      stop()
      vi.clearAllTimers()
    }
  }))
})

test("a request left hanging while the page was hidden doesn't hold up the next one on coming back", async () => {
  await fc.assert(fc.asyncProperty(
    // Hidden before the request would time out, and away for less than the hour that makes the page reload
    fc.integer({ min: 0, max: 14_999 }),
    fc.integer({ min: 0, max: HOUR - 1 }),
    async (before, away) => {
      const { poll, setVisibility } = await load()
      // The first request never answers, as one suspended with the page may not, and the rest answer at once
      const { made, f } = requests([undefined, 0])
      let answered = 0
      const stop = poll(signal => f(signal).then(() => answered++), INTERVAL, () => {})
      try {
        await vi.advanceTimersByTimeAsync(before)
        setVisibility("hidden")
        await vi.advanceTimersByTimeAsync(away)
        const count = made.length
        setVisibility("visible")
        await vi.advanceTimersByTimeAsync(INTERVAL)
        expect(made.length).toBeGreaterThan(count)
        expect(answered).toBeGreaterThan(0)
      }
      finally {
        stop()
        vi.clearAllTimers()
      }
    }
  ))
})

test("stopping cancels the request in flight, and nothing is asked after", async () => {
  const { poll, setVisibility } = await load()
  const { made, f } = requests([undefined])
  const onError = vi.fn()
  const stop = poll(f, INTERVAL, onError)
  stop()
  expect(made[0].signal.aborted).toBe(true)
  setVisibility("hidden")
  setVisibility("visible")
  await vi.advanceTimersByTimeAsync(10 * INTERVAL)
  expect(made).toHaveLength(1)
  expect(onError).not.toHaveBeenCalled()
})

test("a failed request is reported, but a cancelled one isn't", async () => {
  const { poll, setVisibility } = await load()
  const onError = vi.fn()
  const stop = poll(async signal => {
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
  }, INTERVAL, onError)
  setVisibility("hidden")
  await vi.advanceTimersByTimeAsync(0)
  expect(onError).not.toHaveBeenCalled()
  stop()

  setVisibility("visible")
  const failing = poll(() => Promise.reject(new Error("Load failed")), INTERVAL, onError)
  await vi.advanceTimersByTimeAsync(0)
  expect(onError).toHaveBeenCalledTimes(1)
  failing()
})

test("a request taking 15 s is given up on and reported, and the next goes ahead", async () => {
  const { poll } = await load()
  const { made, f } = requests([undefined, 0])
  const onError = vi.fn()
  const stop = poll(f, INTERVAL, onError)
  await vi.advanceTimersByTimeAsync(14_999)
  expect(made).toHaveLength(1)
  expect(onError).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: "TimeoutError" }))
  expect(made).toHaveLength(2)
  stop()
})
