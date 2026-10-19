// The build a page runs and the data it loads, both named in the page's head (manifest.mts). The service worker
// serves the page from its cache and checks the network behind it, and sends a newer copy here. Newer data alone
// is loaded and swapped in live; newer code can only come in with a reload, which the lifecycle makes once the page
// is out of view. The page asks for the check itself too, on coming back into view and every so often, as a window
// that never navigates would otherwise never hear of a nightly build

import { r, type DerivativeNode, type SourceNode } from "bruh/reactive"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { getJson } from "../shared/json.mts"
import { type Generation, buildOf, isSameCode, mergedRetain, retainOf } from "./manifest.mts"

const REVALIDATE_MS = 15 * 60_000
// A load that failed is tried again after these, the last over and over, and at once when something newer is named
const RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000]

const running = buildOf(document.head.outerHTML)
/** Each data file's URL, by its name, as the newest build of this page's code names them */
let announced = running.data

/** Whether a newer build of the page's code is ready, which only a reload brings in */
export const isNewBuild = r(false)

/** A data file the page loads: the URL wanted for it, the one its value came from, and how often the want has failed */
type Slot = {
  wanted:  string,
  loaded?: string,
  attempt: number,
  value:   SourceNode<unknown>,
  load:    (url: string) => Promise<unknown>
}
const slots = new Map<string, Slot>()

const pending = () =>
  [...slots.values()].filter(slot => slot.wanted !== slot.loaded)

let round: Promise<void> | undefined
let retry: ReturnType<typeof setTimeout> | undefined

/**
 * Loads every data file wanted but not yet loaded, all at once, and swaps in all that load in one go, so whatever
 * depends on several sees them together. A file wanted since a round began is loaded right after it, and one that
 * failed again after a while, longer each time
 */
const sync = () => {
  if (round)
    return
  const due = pending().map(slot => ({ slot, url: slot.wanted }))
  if (!due.length)
    return
  round = Promise.allSettled(due.map(({ slot, url }) => slot.load(url)))
    .then(results => {
      round = undefined
      results.forEach((result, i) => {
        const { slot, url } = due[i]
        // Unless something newer was named meanwhile, which is loaded next
        if (slot.wanted !== url)
          return
        if (result.status === "fulfilled") {
          slot.value.value = result.value
          slot.loaded = url
          slot.attempt = 0
        }
        else {
          slot.attempt++
          console.error(result.reason)
        }
      })
      later()
    })
}

/** Loads what's still wanted: at once if any of it is newly wanted, else once the failed have waited their turn */
const later = () => {
  clearTimeout(retry)
  const due = pending()
  if (!due.length)
    return
  if (due.some(slot => !slot.attempt))
    return sync()
  retry = setTimeout(sync, RETRY_MS[Math.min(...due.map(slot => slot.attempt), RETRY_MS.length) - 1])
}

/** Takes in a newer copy of the page, newer data to load or newer code to reload for */
export const receive = (html: string) => {
  const next = buildOf(html)
  if (!isSameCode(next, running)) {
    isNewBuild.value = true
    return
  }
  announced = next.data
  // Named again, the same file is a fresh chance for one that failed
  for (const [name, slot] of slots)
    if (name in next.data) {
      slot.wanted = next.data[name]
      slot.attempt = 0
    }
  later()
}

/**
 * What this window runs, for the service worker's census: its build, with the data as loaded, what that keeps, and
 * the files still loading, so a slow one is still there when it's tried again
 */
const generation = (): Generation => ({
  build:  { ...running, data: { ...running.data, ...Object.fromEntries([...slots].flatMap(([name, { loaded }]) => loaded ? [[name, loaded]] : [])) } },
  retain: mergedRetain([{ files: pending().map(slot => slot.wanted), folders: [] }, ...[...slots.values()].map(slot => retainOf(slot.value.peek()))])
})

navigator.serviceWorker?.addEventListener("message", ({ data, ports }) => {
  const { page, census } = Object(data) as { page?: unknown, census?: unknown }
  if (typeof page === "string")
    receive(page)
  else if (census)
    ports[0]?.postMessage(generation())
})
// Messages sent before now, as while the page was loading, were held for this
navigator.serviceWorker?.startMessages()

const revalidate = () => {
  if (document.visibilityState === "visible")
    navigator.serviceWorker?.controller?.postMessage({ revalidate: location.pathname })
}
setInterval(revalidate, REVALIDATE_MS)
// A first visit's page was served before the worker was there to keep it, so it's asked for as soon as it is
navigator.serviceWorker?.addEventListener("controllerchange", revalidate)
document.addEventListener("visibilitychange", () => {
  revalidate()
  // Back in view is as good a time as any to try again
  if (document.visibilityState === "visible")
    sync()
})

/**
 * A data file the page's head names, by its schema, which its JSON must fit, or by a loader of its own, and loaded
 * again whenever a newer build names a newer one, though only swapped in once loaded, so what depends on it never
 * waits on it, and a file that doesn't fit is a load that failed. Pages await the first, so they start with their
 * data; with a fallback, they start with that if the first load fails, and the file is tried again behind it
 */
export const latest = async <T,>(name: string, by: StandardSchemaV1<unknown, T> | ((url: string) => Promise<T>) = getJson, fallback?: () => T): Promise<DerivativeNode<T>> => {
  const load = typeof by === "function" ? by : (url: string) => getJson(url, { schema: by })
  const wanted = announced[name]
  if (wanted === undefined)
    throw new Error(`The page names no data ${name}`)
  const slot: Slot = { wanted, attempt: 0, value: r<unknown>(undefined), load }
  try {
    slot.value.value = await load(wanted)
    slot.loaded = wanted
  }
  catch (error) {
    if (!fallback)
      throw error
    console.error(error)
    slot.value.value = fallback()
    slot.attempt = 1
  }
  slots.set(name, slot)
  later()
  return slot.value as DerivativeNode<T>
}
