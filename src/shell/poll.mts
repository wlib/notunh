// Asking a live source for something over and over while the page is in view, keeping what it last answered apart
// from how the asking is going: an answer stays good evidence while a later ask fails, and is only as fresh as when
// it was received, which each page judges by its own source's clock and tolerances

import { r, watch } from "bruh/reactive"
import { isVisible } from "./lifecycle.mts"

// A request taking longer has stalled, and would hold up the next ones
const REQUEST_TIMEOUT_MS = 15_000

/** What a live source last answered, and when it was received, if ever, and whether the last ask of it failed */
export type Live<T> = { value?: T, received?: number, isFailing: boolean }

/** A live source's state before it's been asked */
export const live = <T,>() =>
  r<Live<T>>({ isFailing: false })

const timedOut = () =>
  new DOMException("The request took too long", "TimeoutError")

/**
 * Runs f now and every interval while the page is visible, one run at a time, until stopped, reporting what it
 * answers as it comes, and a failure, which keeps the last answer, as a failure. A run still going when the page is
 * hidden is cancelled, as phones suspend it with the page and it would hold up the next one for as long, and coming
 * back runs again right away. Stopping cancels a run still going, so it can't overwrite anything newer
 */
export const poll = <T,>(f: (signal: AbortSignal) => Promise<T>, interval: number, report: (live: Live<T>) => void) => {
  let state: Live<T> = { isFailing: false }
  let current: AbortController | undefined
  const run = () => {
    if (current || !isVisible.peek())
      return
    // One controller for both, rather than AbortSignal.any, which iOS only has from 17.4
    const controller = current = new AbortController()
    const timeout = setTimeout(() => controller.abort(timedOut()), REQUEST_TIMEOUT_MS)
    f(controller.signal)
      .then(value => report(state = { value, received: Date.now(), isFailing: false }), error => {
        // A run cancelled since has nothing to say
        if (current === controller) {
          console.error(error)
          report(state = { ...state, isFailing: true })
        }
      })
      .finally(() => {
        clearTimeout(timeout)
        if (current === controller)
          current = undefined
      })
  }
  const cancel = () => {
    current?.abort()
    current = undefined
  }

  const timer = setInterval(run, interval)
  // Its first run finds the one started below still going, as it comes before any request can finish
  const unwatch = watch([isVisible], () => isVisible.value ? run() : cancel())
  run()
  return () => {
    cancel()
    clearInterval(timer)
    unwatch()
  }
}
