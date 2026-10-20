// Loading a file that never changes under its name: the data files a page's head names (build.mts), and the files
// those name in turn, like dining's menus. A load is given up on after a minute, so a stalled one holds nothing up,
// and a file that doesn't fit its schema is a failed load like any other. A file that failed is asked for again past
// every cache (cache: "reload", which the service worker honors, keeping the fresh copy over the one it had), so a
// malformed copy a cache kept is replaced rather than read again. Failures are retried after 5 s, 15 s, 1 min, then
// every 5 min, and at once when the page comes back into view, until the file loads or isn't wanted any more

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { getJson } from "../shared/json.mts"

/** How a file is loaded from its URL, given an init with a deadline signal, and cache: "reload" on a retry */
export type Loader<T> = (url: string, init: RequestInit) => Promise<T>

const RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000]
const LOAD_TIMEOUT_MS = 60_000

/** A loader of JSON that must fit a schema */
export const jsonOf = <T,>(schema: StandardSchemaV1<unknown, T>): Loader<T> =>
  (url, init) => getJson(url, { ...init, schema })

// Retries waiting out their backoff, each woken when the page comes back into view
const waiting = new Set<() => void>()
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible")
    for (const wake of waiting)
      wake()
})

/** Waits some milliseconds, or until the page comes back into view, or the signal aborts */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer)
      waiting.delete(done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    waiting.add(done)
    signal?.addEventListener("abort", done, { once: true })
  })

/**
 * A file's value, loaded however many tries it takes, or failing once the signal aborts. Each failure is passed to
 * onError first, so whatever waits on the file can say so meanwhile
 */
export const loadImmutable = async <T,>(url: string, load: Loader<T>, { signal, onError = console.error }: { signal?: AbortSignal, onError?: (error: unknown) => void } = {}): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(signal!.reason)
    signal?.addEventListener("abort", abort)
    const deadline = setTimeout(() => controller.abort(new DOMException("The load took too long", "TimeoutError")), LOAD_TIMEOUT_MS)
    try {
      const value = await load(url, { signal: controller.signal, cache: attempt ? "reload" : "default" })
      // A loader may finish what it had despite the abort
      signal?.throwIfAborted()
      return value
    }
    catch (error) {
      signal?.throwIfAborted()
      onError(error)
    }
    finally {
      clearTimeout(deadline)
      signal?.removeEventListener("abort", abort)
    }
    await pause(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)], signal)
  }
}
