// Offline first: every page, its code, and its data come from the cache at once, and the network is asked behind
// them. A page's head is its release manifest (src/shell/manifest.mts): a newer copy is kept only once everything
// it names is, so it opens whole offline, and the pages' windows are told, to swap in its data or reload for its
// code. Hashed files never change, so they're kept until no generation needs them (retention.mts); the icons and
// the manifest keep their names, so they're fetched fresh; live data is never cached

import { type Build, type Generation, buildOf, closureOf, isSameBuild, retainOf } from "../shell/manifest.mts"
import { TILES_FOLDER } from "../map/tiles.mts"
import { STYLE_ROOT } from "../map/style.mts"
import { type CacheLike, ANY, deleteWhere, generationOf, isBrandAsset, pageOf, pathOf, prune } from "./retention.mts"

type Extendable = { waitUntil(promise: Promise<unknown>): void }
type FetchLike = Extendable & { request: Request, respondWith(response: Promise<Response>): void }
type MessageLike = Extendable & { data: unknown }
type Window = { url: string, postMessage(message: unknown, transfer?: Transferable[]): void }

/** What the worker uses of its global scope, so tests can hand it one of their own */
export type Scope = {
  addEventListener(type: "install" | "activate", listener: (event: Extendable) => void): void,
  addEventListener(type: "fetch", listener: (event: FetchLike) => void): void,
  addEventListener(type: "message", listener: (event: MessageLike) => void): void,
  skipWaiting(): Promise<void>,
  clients:  { claim(): Promise<void>, matchAll(options: { type: "window" }): Promise<Window[]> },
  caches:   { open(name: string): Promise<CacheLike>, keys(): Promise<string[]>, delete(name: string): Promise<boolean> },
  fetch:    (input: Request | string, init?: RequestInit) => Promise<Response>,
  location: { origin: string }
}

// Named anew when what's kept changes meaning, as it did when pages began naming their data: activating lets the
// older cache go whole, since pages kept under the old rules can't be told whole from not
const CACHE = "app-v2"
/** Where a page's previous generation is kept, beside its current one, for windows that can't say they run it */
const PREVIOUS = "?gen=prev"
/** How long windows get to say what they run; one that can't, as frozen or in the back-forward cache, is covered by its page's previous generation */
const CENSUS_MS = 1000

export const start = (scope: Scope) => {
  const open = () => scope.caches.open(CACHE)
  const windows = () => scope.clients.matchAll({ type: "window" })

  /** What each open window runs, from those that answer in time */
  const census = async (): Promise<Generation[]> => {
    const answers = (await windows()).map(client => new Promise<Generation | undefined>(resolve => {
      const { port1, port2 } = new MessageChannel()
      const answer = (generation?: Generation) => {
        port1.close()
        resolve(generation)
      }
      port1.onmessage = ({ data }) => {
        const { build, retain } = Object(data) as { build?: Build, retain?: unknown }
        answer(build && { build: { release: build.release ?? "", code: build.code ?? [], data: build.data ?? {} }, retain: retainOf(retain) })
      }
      setTimeout(answer, CENSUS_MS)
      client.postMessage({ census: true }, [port2])
    }))
    return (await Promise.all(answers)).filter(generation => generation !== undefined)
  }

  // Generations being taken in, whose files are kept through any pruning meanwhile
  const incoming = new Set<Generation>()
  const live = async () => [...incoming, ...await census()]

  // What can be let go when the origin's quota is hit, cheapest to refill first, each a whole class so there's no
  // record of use to keep: what no generation needs, then the tiles, then the style's fonts and sprites. Pages, what
  // they name, and the style itself stay
  const SURRENDERABLE = [
    (cache: CacheLike) => prune(cache, live),
    (cache: CacheLike) => deleteWhere(cache, pathname => pathname.startsWith(TILES_FOLDER)),
    (cache: CacheLike) => deleteWhere(cache, pathname => pathname.startsWith(STYLE_ROOT) && !pathname.endsWith("/style.json"))
  ]
  // How far down the ladder the last quota failure got, so a storm of failing puts doesn't climb it once each
  let surrendered = 0

  /** Keeps a response if there's room, making room once if there isn't, and answers with it either way */
  const store = async (request: Request | string, response: Response): Promise<Response> => {
    if (!response.ok)
      return response
    const cache = await open()
    try {
      await cache.put(request, response.clone())
      surrendered = 0
    }
    catch (error) {
      if ((error as Error | undefined)?.name !== "QuotaExceededError" || surrendered === SURRENDERABLE.length)
        return response
      await SURRENDERABLE[surrendered++](cache)
      return store(request, response)
    }
    return response
  }

  /** An asset in the cache, fetched if it isn't, failing if it can't be */
  const ensure = async (cache: CacheLike, asset: string) => {
    if (await cache.match(asset, ANY))
      return
    const response = await scope.fetch(asset)
    if (!response.ok)
      throw new Error(`${response.status} from ${asset}`)
    await store(asset, response)
  }

  /**
   * The network's own copy of a page, asked past the browser's cache, with its HTML and build if it's one of ours.
   * Anything that isn't a page, like an error, passes through, as does one of ours reached by a redirect, like /map
   * to /map/, which is kept under its own path when that's visited; but a page without a release is a captive
   * portal's sign-in or the like, answering in place of ours
   */
  const fetchPage = async (url: string) => {
    const response = await scope.fetch(url, { cache: "no-cache" })
    if (!response.ok || !/^text\/html/.test(response.headers.get("content-type") ?? ""))
      return { response }
    const html = await response.clone().text()
    const build = buildOf(html)
    if (!build.release)
      return { response, isForeign: true }
    return response.redirected ? { response } : { response, copy: response.clone(), html, build }
  }

  /**
   * Takes in the network's copy of a page, fetched behind the one served. One of an older release than the copy
   * kept, as from an edge not yet caught up, is left alone, and the same build again changes nothing. A newer copy
   * is kept only once everything it names is, with the copy before it as the page's previous generation, and then
   * sent to the page's open windows, which swap in its data, or reload for its code once out of view, and what no
   * generation needs any more is let go
   */
  const revalidate = async (page: string, fresh: ReturnType<typeof fetchPage>) => {
    const { copy, html, build } = await fresh
    if (!build)
      return
    const cache = await open()
    const cached = await cache.match(page)
    const current = cached && buildOf(await cached.clone().text())
    if (current && build.release < current.release)
      return
    if (current && isSameBuild(current, build)) {
      if (build.release !== current.release)
        await cache.put(page, copy)
      return
    }
    const generation = { build, retain: retainOf(undefined) }
    incoming.add(generation)
    try {
      await Promise.all(closureOf(build).map(asset => ensure(cache, asset)))
      if (cached)
        await cache.put(page + PREVIOUS, cached)
      await cache.put(page, copy)
    }
    finally {
      incoming.delete(generation)
    }
    for (const client of await windows())
      if (pageOf(new URL(client.url).pathname) === page)
        client.postMessage({ page: html })
    await prune(cache, live)
  }

  // One page taken in at a time, so what one brings in is never mistaken for leftovers by another's pruning
  let queue: Promise<unknown> = Promise.resolve()
  const serially = (task: () => Promise<unknown>) =>
    queue = queue.then(task, task)

  // The home page is kept from the start, whole, to show offline in place of any page not visited yet
  scope.addEventListener("install", event => {
    event.waitUntil(serially(() => revalidate("/", fetchPage("/"))).then(() => scope.skipWaiting()))
  })

  scope.addEventListener("activate", event => {
    event.waitUntil(
      scope.caches.keys()
        .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => scope.caches.delete(key))))
        .then(() => scope.clients.claim())
        .then(() => serially(async () => prune(await open(), live)))
    )
  })

  // A page asks for its own copy to be checked, as on coming back into view, since a window that never navigates
  // would otherwise never learn of a newer build
  scope.addEventListener("message", event => {
    const { revalidate: path } = Object(event.data) as { revalidate?: unknown }
    if (typeof path !== "string")
      return
    const page = pageOf(new URL(path, scope.location.origin).pathname)
    event.waitUntil(serially(() => revalidate(page, fetchPage(page))).catch(() => {}))
  })

  scope.addEventListener("fetch", event => {
    const { request } = event
    const url = new URL(request.url)
    // The API is live, so it's never cached here
    if (request.method !== "GET" || url.origin !== scope.location.origin || url.pathname.startsWith("/api/"))
      return

    // Pages: the copy we have right away, checked behind it. Without one, the network's, though not a captive
    // portal's in place of ours while there's the home page to show instead, and failing that the home page
    if (request.mode === "navigate") {
      const page = pageOf(url.pathname)
      const fresh = fetchPage(url.href)
      event.waitUntil(serially(() => revalidate(page, fresh)).catch(() => {}))
      event.respondWith(
        open()
          .then(async cache =>
            await cache.match(page) ??
            await fresh.then(({ response, isForeign }) => isForeign ? undefined : response, () => undefined) ??
            await cache.match("/") ??
            (await fresh).response
          )
      )
    }
    // Icons and the manifest: fresh when online, cached when not
    else if (isBrandAsset(url.pathname))
      event.respondWith(
        scope.fetch(request, { cache: "no-cache" })
          .then(response => store(request, response))
          .catch(async () => (await (await open()).match(request, ANY))!)
      )
    // Everything else, code, data, the map's style and tiles, and the dining files: cached first, filled on first use
    else
      event.respondWith(
        open()
          .then(async cache => await cache.match(request, ANY) ?? store(request, await scope.fetch(request)))
      )
  })
}
