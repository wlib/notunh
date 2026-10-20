// Polling a live source while the page is in view. What it last answered is kept apart from whether asking is
// failing: an answer stays good evidence while later asks fail, and is only as fresh as when it was received. Each
// page judges that freshness by its own source's clock and tolerances

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
 * Runs f now and every interval while the page is visible, one run at a time, until stopped. Each answer is reported
 * as it comes; a failure is reported as failing, keeping the last answer. A run still going when the page is hidden
 * is cancelled, since phones suspend it with the page and it would hold up the next one as long. Coming back into
 * view runs again at once. Stopping cancels a run still going, so it can't overwrite anything newer
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
  // Its first run is a no-op: it finds the run started below still going, as no request can finish before it
  const unwatch = watch([isVisible], () => isVisible.value ? run() : cancel())
  run()
  return () => {
    cancel()
    clearInterval(timer)
    unwatch()
  }
}
