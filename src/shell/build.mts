// The build a page runs and the data it loads, both named in the page's head (manifest.mts). The service worker
// serves the page from its cache, revalidates it behind that, and posts any newer copy here. Newer data alone is
// loaded and swapped in live. Newer code only comes in with a reload, which lifecycle.mts makes once the page is out
// of view. The page also asks the worker to revalidate, on coming back into view and every REVALIDATE_MS, since a
// window that never navigates would otherwise never hear of the nightly build.
//
// Every data file is its own slot, loaded and swapped in on its own. A page's files join only by stable ids and
// coordinates: the timetable's stop and route ids, the model's, the gazetteer's and places' positions, and the
// dining index's content-named children. So any build's file works with any other's, and whatever is derived from
// several is derived again from whichever are newest. Nothing references another file by position, so nothing has
// to be swapped in as a group, and a file that can't load holds no other back

import { r, type DerivativeNode, type SourceNode } from "bruh/reactive"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { getJson } from "../shared/json.mts"
import { type Generation, buildOf, isOlder, isSameCode, mergedRetain, retainOf } from "./manifest.mts"

const REVALIDATE_MS = 15 * 60_000
// Backoff for a failed load: these in turn, then the last one indefinitely. A newer file named is tried at once
const RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000]
// A load taking longer has stalled. It fails like any other, so it can't hold up the loads after it
const LOAD_TIMEOUT_MS = 60_000

const running = buildOf(document.head.outerHTML)
/** The newest build with this page's code announced so far, whose data files are the ones wanted */
let announced = running

/** Whether a newer build of the page's code is ready, which only a reload brings in */
export const isNewBuild = r(false)

/** How a data file is loaded from its URL, given an init with a deadline signal, and cache: "reload" on a retry */
export type Loader<T> = (url: string, init: RequestInit) => Promise<T>

/** A data file the page loads: the URL wanted for it, the one its value came from, the one loading, and its failures */
type Slot = {
  wanted:   string,
  loaded?:  string,
  loading?: string,
  /** How many times in a row loading the wanted URL has failed, and when it last did (epoch ms) */
  attempt:  number,
  failedAt: number,
  value:    SourceNode<unknown>,
  load:     Loader<unknown>
}
const slots = new Map<string, Slot>()

let retry: ReturnType<typeof setTimeout> | undefined

/** Milliseconds until a slot's wanted URL is due: now if it hasn't failed, else backed off by RETRY_MS */
const dueIn = (slot: Slot, now: number) =>
  slot.attempt ? Math.max(0, slot.failedAt + RETRY_MS[Math.min(slot.attempt, RETRY_MS.length) - 1] - now) : 0

/**
 * Loads what a slot wants and swaps it in. If something newer was named meanwhile, that's loaded instead, whatever
 * came of this. A failure is noted for the next try, and thrown. A retry asks past every cache, so a file that
 * answered as the wrong thing, and was kept by the worker anyway, is fetched afresh
 */
const attempt = async (slot: Slot): Promise<void> => {
  const url = slot.loading = slot.wanted
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new DOMException("The load took too long", "TimeoutError")), LOAD_TIMEOUT_MS)
  const result = await slot.load(url, { signal: controller.signal, cache: slot.attempt ? "reload" : "default" })
    .then(value => ({ value }), (error: unknown) => ({ error }))
  clearTimeout(deadline)
  if (slot.wanted !== url)
    return attempt(slot)
  slot.loading = undefined
  if ("error" in result) {
    slot.attempt++
    slot.failedAt = Date.now()
    sync()
    throw result.error
  }
  slot.value.value = result.value
  slot.loaded = url
  slot.attempt = 0
}

/** Loads every wanted file that's due and not loaded or loading, and schedules itself for the soonest of the rest */
const sync = () => {
  clearTimeout(retry)
  const now = Date.now()
  const waits: number[] = []
  for (const slot of slots.values()) {
    if (slot.wanted === slot.loaded || slot.loading !== undefined)
      continue
    const wait = dueIn(slot, now)
    if (wait)
      waits.push(wait)
    else
      attempt(slot).catch(console.error)
  }
  if (waits.length)
    retry = setTimeout(sync, Math.min(...waits))
}

/**
 * Takes in a newer copy of the page: newer data to load, or newer code to reload for. One published before the
 * newest announced, like a message that arrived late, changes nothing. One republished since, as a rollback is, counts
 * as newer however long ago it was built
 */
export const receive = (html: string) => {
  const next = buildOf(html)
  if (isOlder(next, announced))
    return
  if (!isSameCode(next, running)) {
    isNewBuild.value = true
    return
  }
  announced = next
  // A file named again, even the same one, gets a fresh start on its retries
  for (const [name, slot] of slots)
    if (name in next.data) {
      slot.wanted = next.data[name]
      slot.attempt = 0
    }
  sync()
}

/**
 * What this window runs, for the service worker's census: its build with the data files actually loaded, what those
 * ask the cache to retain, and the files still wanted, so a slow one isn't pruned before it's tried again
 */
const generation = (): Generation => ({
  build:  { ...running, data: { ...running.data, ...Object.fromEntries([...slots].flatMap(([name, { loaded }]) => loaded ? [[name, loaded]] : [])) } },
  retain: mergedRetain([
    retainOf({ files: [...slots.values()].flatMap(slot => slot.wanted === slot.loaded ? [] : [slot.wanted]) }),
    ...[...slots.values()].map(slot => retainOf(slot.value.peek()))
  ])
})

navigator.serviceWorker?.addEventListener("message", ({ data, ports }) => {
  const { page, census } = Object(data) as { page?: unknown, census?: unknown }
  if (typeof page === "string")
    receive(page)
  else if (census)
    ports[0]?.postMessage(generation())
})
// Messages sent before now, as while the page was loading, were queued until this
navigator.serviceWorker?.startMessages()

const revalidate = () => {
  if (document.visibilityState === "visible")
    navigator.serviceWorker?.controller?.postMessage({ revalidate: location.pathname })
}
setInterval(revalidate, REVALIDATE_MS)
// A first visit's page was served before the worker controlled it, so revalidate as soon as the worker takes over
navigator.serviceWorker?.addEventListener("controllerchange", revalidate)
document.addEventListener("visibilitychange", () => {
  revalidate()
  // Coming back into view retries failed loads at once, whatever their backoff
  if (document.visibilityState === "visible") {
    for (const slot of slots.values())
      slot.failedAt = -Infinity
    sync()
  }
})

/**
 * A data file the page's head names, loaded by a schema its JSON must fit or by a loader of its own. It's loaded
 * again whenever a newer build names a newer file, and only swapped in once loaded, so what depends on it never
 * waits. A file that doesn't fit its schema is a failed load. Pages await the first load, so they start with their
 * data. With a fallback, they start with that if the first load fails, and the file is retried behind it. A newer
 * build announced during the first load is loaded right after it
 */
export const latest = async <T,>(name: string, by: StandardSchemaV1<unknown, T> | Loader<T> = getJson, fallback?: () => T): Promise<DerivativeNode<T>> => {
  const load: Loader<T> = typeof by === "function" ? by : (url, init) => getJson(url, { ...init, schema: by })
  const wanted = announced.data[name]
  if (wanted === undefined)
    throw new Error(`The page names no data ${name}`)
  const slot: Slot = { wanted, attempt: 0, failedAt: 0, value: r<unknown>(undefined), load }
  slots.set(name, slot)
  try {
    await attempt(slot)
  }
  catch (error) {
    if (!fallback)
      throw error
    console.error(error)
    slot.value.value = fallback()
  }
  return slot.value as DerivativeNode<T>
}
