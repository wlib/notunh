// Asking a server for something over and over while the page is in view

import { watch } from "bruh/reactive"
import { isVisible } from "./lifecycle.mts"

// A request taking longer has stalled, and would hold up the next ones
const REQUEST_TIMEOUT_MS = 15_000

const timedOut = () =>
  new DOMException("The request took too long", "TimeoutError")

/**
 * Runs f now and every interval while the page is visible, one run at a time, until stopped. A run still going
 * when the page is hidden is cancelled, as phones suspend it with the page and it would hold up the next one for
 * as long, and coming back runs again right away. Stopping cancels a run still going, so it can't overwrite
 * anything newer
 */
export const poll = (f: (signal: AbortSignal) => Promise<unknown>, interval: number, onError: (error: unknown) => void = console.error) => {
  let current: AbortController | undefined
  const run = () => {
    if (current || !isVisible.peek())
      return
    // One controller for both, rather than AbortSignal.any, which iOS only has from 17.4
    const controller = current = new AbortController()
    const timeout = setTimeout(() => controller.abort(timedOut()), REQUEST_TIMEOUT_MS)
    f(controller.signal)
      .catch(error => {
        // A run cancelled since has nothing to say
        if (current === controller)
          onError(error)
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
