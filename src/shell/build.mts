// The build a page runs and the data it loads, both named in the page's head (manifest.mts). The service worker
// serves the page from its cache, revalidates it behind that, and posts any newer copy here. Newer data alone is
// loaded and swapped in live. Newer code only comes in with a reload, which lifecycle.mts makes once the page is out
// of view. The page also asks the worker to revalidate, on coming back into view and every REVALIDATE_MS, since a
// window that never navigates would otherwise never hear of the nightly build.
//
// Every data file is its own slot, loaded and swapped in on its own (load.mts), so a file that can't load holds no
// other back. That's sound because what must match is matched within a slot, and the rest only meets by stable ids
// and coordinates:
// - Must match, and is checked or named so: a file with the code reading it (its schema, and the model's version);
//   the style with its sprite and fonts (one folder named by their hash, loaded with the manifest naming it); the
//   dining index with its files and the tiles manifest with its folder (each named by its content)
// - May mix: the timetable with the model (stop and route ids), and both with the walk network, gazetteer, places,
//   and tiles (coordinates); the style with the tiles (layer names). A file from another build may say otherwise of
//   the same id, as a route keeping its id through a new path, whose times the model learned on the old one. That's
//   a forecast off until relearned, as it is within one build, never an index misread. A campus layer renamed in
//   the style draws nothing until the tiles of its schema come
// Whatever is derived from several files is derived again from whichever are newest

import { r, type DerivativeNode, type SourceNode } from "bruh/reactive"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { readJson } from "../shared/json.mts"
import { type Generation, buildOf, isOlder, isSameCode, mergedRetain, retainOf } from "./manifest.mts"
import { type Loader, jsonOf, loadImmutable } from "./load.mts"

const REVALIDATE_MS = 15 * 60_000

const running = buildOf(document.head.outerHTML)
/** The newest build with this page's code announced so far, whose data files are the ones wanted */
let announced = running

/** Whether a newer build of the page's code is ready, which only a reload brings in */
export const isNewBuild = r(false)

/** A data file the page loads: the URL wanted for it, the one its value came from, and the load of the one wanted */
type Slot = {
  wanted?:  string,
  loaded?:  string,
  loading?: AbortController,
  value:    SourceNode<unknown>,
  load:     Loader<unknown>,
  /** Called whenever a value is swapped in */
  swapped:  () => void
}
const slots = new Map<string, Slot>()
/** Each slot's first load, which pages wait for */
const firstLoads: Promise<void>[] = []

/**
 * Wants a URL for a slot, loading it (load.mts) and swapping it in once loaded, in place of whatever else the slot was
 * loading. One wanted already is loaded or loading, so it's left as it is
 */
const want = (slot: Slot, url: string, onError?: (error: unknown) => void) => {
  if (url === slot.wanted)
    return
  slot.loading?.abort()
  slot.wanted = url
  slot.loading = undefined
  if (url === slot.loaded)
    return
  const loading = slot.loading = new AbortController()
  loadImmutable(url, slot.load, { signal: loading.signal, onError }).then(value => {
    slot.value.value = value
    slot.loaded = url
    slot.loading = undefined
    slot.swapped()
  }, () => {})
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
  for (const [name, slot] of slots)
    if (name in next.data)
      want(slot, next.data[name])
}

/**
 * What this window runs, for the service worker's census: its build with the data files actually loaded, what those
 * ask the cache to retain, and the files still wanted, so a slow one isn't pruned before it's tried again
 */
const generation = (): Generation => ({
  build:  { ...running, data: { ...running.data, ...Object.fromEntries([...slots].flatMap(([name, { loaded }]) => loaded ? [[name, loaded]] : [])) } },
  retain: mergedRetain([
    retainOf({ files: [...slots.values()].flatMap(({ wanted, loaded }) => wanted === loaded || !wanted ? [] : [wanted]) }),
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
// A first visit's page was served before the worker controlled it, so revalidate once the worker takes over and the
// page has its data. The worker then finds each file in the HTTP cache, where alongside the page it downloaded it again
navigator.serviceWorker?.addEventListener("controllerchange", () => void Promise.all(firstLoads).then(revalidate))
document.addEventListener("visibilitychange", revalidate)

/**
 * A data file the page's head names, loaded by a schema its JSON must fit or by a loader of its own. It's loaded
 * again whenever a newer build names a newer file, and only swapped in once loaded, so what depends on it never
 * waits. Pages await the first load, so they start with their data, however many tries that takes. With a fallback,
 * they start with that if the first try fails, and the file is swapped in once it loads. A newer build announced
 * meanwhile is loaded instead
 */
export const latest = async <T,>(name: string, by: StandardSchemaV1<unknown, T> | Loader<T> = response => readJson<T>(response), fallback?: () => T): Promise<DerivativeNode<T>> => {
  const url = announced.data[name]
  if (url === undefined)
    throw new Error(`The page names no data ${name}`)
  const value = r<unknown>(undefined)
  const loaded = new Promise<void>(resolve => {
    const slot: Slot = { value, load: typeof by === "function" ? by : jsonOf(by), swapped: resolve }
    slots.set(name, slot)
    want(slot, url, error => {
      console.error(error)
      if (fallback && value.peek() === undefined) {
        value.value = fallback()
        resolve()
      }
    })
  })
  firstLoads.push(loaded)
  await loaded
  return value as DerivativeNode<T>
}
