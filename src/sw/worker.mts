// Offline first: every page, its code, and its data are answered from the cache at once, and the network is checked
// behind them. A page's head is its release manifest (src/shell/manifest.mts). A newer copy of a page is kept only
// once everything it names is confirmed kept, so any kept page opens whole offline. The page's windows are then told,
// so they can swap in its data or reload for its code. Hashed files never change, so they're kept until no
// generation needs them (retention.mts). The icons and the web manifest keep fixed names, so they're fetched fresh.
// Live data (/api/) is never cached.
//
// Two contracts, kept apart:
// - Answering a request is best effort about the cache. A failed put, a full quota, or a cache that won't open
//   never fails a response.
// - Staging a release is strict. A file that can't be kept, that answers as something other than what its name
//   says, or that doesn't arrive in time keeps the release from being promoted.
// Neither holds up the other's writes for long: whatever stalls is given up on at DEADLINE_MS

import { type Build, type Generation, buildOf, closureOf, isOlder, isSameBuild, retainOf } from "../shell/manifest.mts"
import { TILES_FOLDER } from "../map/basemap/tiles.mts"
import { STYLE_ROOT } from "../map/basemap/style.mts"
import { type CacheLike, ANY, deleteWhere, generationOf, isBrandAsset, isHashed, pageOf, prune } from "./retention.mts"
import { CACHE as REMINDERS } from "../reminders/browser/store.mts"

type Extendable = { waitUntil(promise: Promise<unknown>): void }
type FetchLike = Extendable & { request: Request, clientId?: string, respondWith(response: Promise<Response>): void }
type MessageLike = Extendable & { data: unknown }
type Window = { id: string, url: string, postMessage(message: unknown, transfer?: Transferable[]): void, navigate(url: string): Promise<unknown> }

/** What the worker uses of its global scope, so tests can hand it one of their own */
export type Scope = {
  addEventListener(type: "install" | "activate", listener: (event: Extendable) => void): void,
  addEventListener(type: "fetch", listener: (event: FetchLike) => void): void,
  addEventListener(type: "message", listener: (event: MessageLike) => void): void,
  skipWaiting(): Promise<void>,
  clients:  { claim(): Promise<void>, get(id: string): Promise<Window | undefined>, matchAll(options: { type: "window" }): Promise<Window[]> },
  caches:   { open(name: string): Promise<CacheLike>, keys(): Promise<string[]>, delete(name: string): Promise<boolean> },
  fetch:    (input: Request | string, init?: RequestInit) => Promise<Response>,
  location: { origin: string }
}

// Renamed whenever what's kept changes meaning, so activating deletes every older cache, the reminders' apart, which
// pages write too (src/reminders/browser/store.mts). The first worker's pages
// named only their code and loaded their data by URL, so what they need can't be told. Their pages are fetched
// afresh instead, like pages not visited yet
const CACHE = "app-v2"
/** Where a page's previous generation is kept, beside its current one, for windows that can't say they run it */
const PREVIOUS = "?gen=prev"
/**
 * How long windows get to answer the census. One that can't, being frozen or in the back-forward cache, is covered
 * by its page's previous generation
 */
const CENSUS_MS = 1000
/** How long a page fetch, a staging, or a put behind an answer may take, bodies included, as long as a page's loads */
const DEADLINE_MS = 60_000

/** A controller that aborts at the deadline, if nothing aborts it first */
const deadline = () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException("It took too long", "TimeoutError")), DEADLINE_MS)
  return controller
}

/**
 * The content type a file's extension requires. Whatever answers in a file's place with a 200, like a captive
 * portal's sign-in page or a host's error page, fails it. A file with no entry here only mustn't be HTML
 */
const TYPE_OF: [name: RegExp, type: RegExp][] = [[/\.m?js$/, /javascript/], [/\.css$/, /css/], [/\.json$/, /json/]]

/**
 * Whether a response passes for the file its name says, by status and content type, so it can be kept at a URL that
 * never changes. This guards against something else answering in the file's place; it doesn't verify the bytes
 */
const isKeepable = (pathname: string, response: Response) => {
  if (!response.ok)
    return false
  const type = response.headers.get("content-type") ?? ""
  const expected = TYPE_OF.find(([name]) => name.test(pathname))?.[1]
  return expected ? expected.test(type) : !/^text\/html/.test(type)
}

export const start = (scope: Scope) => {
  const open = () => scope.caches.open(CACHE)
  const windows = () => scope.clients.matchAll({ type: "window" })

  /** What a window runs, if it answers in time */
  const generationIn = (client: Window) => new Promise<Generation | undefined>(resolve => {
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
  })

  /** What each open window runs, from those that answer in time */
  const census = async (): Promise<Generation[]> =>
    (await Promise.all((await windows()).map(generationIn))).filter(generation => generation !== undefined)

  // Windows already reloaded by recover, so one whose page fails again isn't reloaded in a loop
  const reloaded = new Set<string>()
  /**
   * Reloads a window whose hashed file is gone, if its page is too old to answer the census: one from the first
   * worker, before pages named their data, whose code can't recover on its own. A page that answers retries its loads
   */
  const recover = async (clientId?: string) => {
    if (!clientId || reloaded.has(clientId))
      return
    const client = await scope.clients.get(clientId)
    if (!client || await generationIn(client))
      return
    reloaded.add(clientId)
    await client.navigate(client.url)
  }

  // Generations being staged, whose files survive any pruning that runs meanwhile
  const incoming = new Set<Generation>()
  const live = async () => [...incoming, ...await census()]

  // What can be deleted when the origin's quota is hit, cheapest to refill first: what no generation needs, then the
  // map tiles, then the style's fonts and sprites. Each rung is a whole class of files, so no record of use is needed.
  // Pages, what they name, and style.json itself always stay
  const SURRENDERABLE = [
    (cache: CacheLike) => prune(cache, live),
    (cache: CacheLike) => deleteWhere(cache, pathname => pathname.startsWith(TILES_FOLDER)),
    (cache: CacheLike) => deleteWhere(cache, pathname => pathname.startsWith(STYLE_ROOT) && !pathname.endsWith("/style.json"))
  ]
  // The rungs surrendered in the current storm of quota failures. A storm lasts until a put succeeds or the next page
  // is taken in. Every put failing during it shares each rung's surrender, pending or done, rather than climbing the
  // ladder again on its own
  let storm: Promise<void>[] = []

  /** Puts a response, making room a rung at a time on QuotaExceededError; resolves to whether it was kept */
  const keep = async (cache: CacheLike, request: Request | string, response: Response) => {
    const surrendered = storm
    for (let rung = 0; ; ) {
      for (; rung < surrendered.length; rung++)
        await surrendered[rung]
      try {
        await cache.put(request, response.clone())
        if (storm === surrendered)
          storm = []
        return true
      }
      catch (error) {
        if ((error as Error | undefined)?.name !== "QuotaExceededError" || rung === SURRENDERABLE.length)
          return false
        surrendered[rung] ??= SURRENDERABLE[rung](cache).catch(() => {})
      }
    }
  }

  // Every cache write and every pruning runs one at a time on this queue. Only one page is taken in at a time, so
  // another's pruning never mistakes what it brings in for leftovers, and nothing is put while a pruning runs. Reads,
  // which answer requests, don't wait for it
  let queue: Promise<unknown> = Promise.resolve()
  const serially = (task: () => Promise<unknown>) =>
    queue = queue.then(task, task)

  /**
   * Keeps a response behind the answer if it's keepable and the cache allows; never fails the answer. A stalled body
   * holds the queue only until the deadline. A put that lands later only adds an immutable file, which pruning
   * deletes if nothing needs it
   */
  const store = (request: Request, response: Response, wanted = () => true) =>
    isKeepable(new URL(request.url).pathname, response)
      ? serially(() => wanted() ? open().then(cache => Promise.race([
        keep(cache, request, response),
        new Promise(resolve => setTimeout(resolve, DEADLINE_MS))
      ])) : Promise.resolve()).catch(() => {})
      : Promise.resolve()

  // Hashed files on their way from the network, by URL, until all of each has come, so a page asking for one being
  // staged, or the other way around, shares the one download. After that the HTTP cache has it (public/_headers), but
  // Safari's doesn't join requests still on their way, so each downloaded it again
  const downloading = new Map<string, Promise<Response>>()

  /** A hashed file from the network, a copy of the download already on its way, if any, by the deadline */
  const download = (url: string) => {
    let response = downloading.get(url)
    if (!response) {
      downloading.set(url, response = scope.fetch(url, { signal: deadline().signal }))
      response.then(response => response.clone().arrayBuffer()).catch(() => {}).finally(() => downloading.delete(url))
    }
    return response.then(response => response.clone())
  }

  // A newer network request, especially a reload, supersedes any older answer still waiting to be stored.
  const writes = new Map<string, object>()

  /**
   * A hashed file: the cached copy, unless the request says cache: "reload", as a page's retry of a failed load
   * does. Otherwise the network's, kept behind the answer, falling back to the cached copy offline
   */
  const cachedFirst = async (event: FetchLike) => {
    const { request } = event
    const copy = await open().then(cache => cache.match(request, ANY)).catch(() => undefined)
    if (copy && request.cache !== "reload")
      return copy
    // One that asks past the HTTP cache gets a download of its own
    const write = {}
    writes.set(request.url, write)
    const current = () => writes.get(request.url) === write
    const finished = () => { if (current()) writes.delete(request.url) }
    try {
      const response = await (request.cache === "default" ? download(request.url) : scope.fetch(request)).catch(error => copy ?? Promise.reject(error))
      if (response !== copy)
        event.waitUntil(store(request, response.clone(), current).finally(finished))
      else
        finished()
      return response
    }
    catch (error) {
      finished()
      throw error
    }
  }

  /**
   * Waits for every task, aborting the rest at the first failure. The failure is thrown only once all have settled,
   * so nothing of a failed staging outlives it
   */
  const all = async (tasks: Promise<unknown>[], controller: AbortController) => {
    await Promise.allSettled(tasks.map(task => task.catch(error => controller.abort(error))))
    if (controller.signal.aborted)
      throw controller.signal.reason
  }

  /**
   * Makes sure a file is cached, fetching and keeping it if it isn't. Fails if it can't be kept, isn't what its name
   * says, or is aborted first
   */
  const ensure = async (cache: CacheLike, asset: string, signal: AbortSignal) => {
    if (await cache.match(asset, ANY))
      return
    const response = await Promise.race([download(new URL(asset, scope.location.origin).href), new Promise<never>((_, reject) => {
      signal.throwIfAborted()
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })])
    if (!isKeepable(asset, response))
      throw new Error(`${response.status} ${response.headers.get("content-type")} from ${asset}`)
    if (!await keep(cache, asset, response))
      throw new Error(`Couldn't keep ${asset}`)
  }

  /**
   * Caches everything a generation needs by the deadline: its build's code and data, then what those data files say
   * they require. The generation's retain is filled in as it goes, so no pruning meanwhile deletes any of it
   */
  const stage = async (cache: CacheLike, generation: Generation) => {
    const controller = deadline()
    const ensureAll = (assets: string[]) => all(assets.map(asset => ensure(cache, asset, controller.signal)), controller)
    await ensureAll(closureOf(generation.build))
    generation.retain = (await generationOf(cache, generation.build)).retain
    await ensureAll(generation.retain.required)
  }

  /**
   * The network's copy of a page, revalidated past the browser's cache, with its HTML and build if it's one of ours.
   * A response that isn't an HTML page, like an error, passes through without a build. So does one of ours reached
   * by a redirect, like /map to /map/, which gets kept under its own path when that's visited. An HTML page without a
   * release meta is foreign: a captive portal's sign-in or the like. A page not whole by the deadline fails
   */
  const fetchPage = async (url: string) => {
    const response = await scope.fetch(url, { cache: "no-cache", signal: deadline().signal })
    if (!response.ok || !/^text\/html/.test(response.headers.get("content-type") ?? ""))
      return { response }
    const html = await response.clone().text()
    const build = buildOf(html)
    if (!build.release)
      return { response, isForeign: true }
    return response.redirected ? { response } : { response, copy: response.clone(), html, build }
  }

  /**
   * Takes in the network's copy of a page, fetched behind the one served:
   * - One published before the kept copy, as from an edge not yet caught up, is ignored.
   * - The same build again changes nothing, though a republished copy replaces the page itself.
   * - A newer build is staged, and kept only once everything it needs is confirmed kept, with the copy before it
   *   kept as the page's previous generation. Then it's posted to the page's open windows, which swap in its data or
   *   reload for its code once out of view, and whatever no generation needs any more is pruned
   */
  const revalidate = async (page: string, fresh: ReturnType<typeof fetchPage>) => {
    const { copy, html, build } = await fresh
    if (!build)
      return
    const cache = await open()
    const cached = await cache.match(page)
    const current = cached && buildOf(await cached.clone().text())
    if (current && isOlder(build, current))
      return
    // Each page taken in starts a fresh storm, whatever an earlier one gave up on
    storm = []
    if (current && isSameBuild(current, build)) {
      if (isOlder(current, build))
        await keep(cache, page, copy)
      return
    }
    const generation = { build, retain: retainOf(undefined) }
    incoming.add(generation)
    try {
      await stage(cache, generation)
      if (cached && !await keep(cache, page + PREVIOUS, cached))
        throw new Error(`Couldn't keep the previous ${page}`)
      if (!await keep(cache, page, copy))
        throw new Error(`Couldn't keep ${page}`)
    }
    finally {
      incoming.delete(generation)
    }
    for (const client of await windows())
      if (pageOf(new URL(client.url).pathname) === page)
        client.postMessage({ page: html })
    await prune(cache, live)
  }

  // The home page is staged whole at install, to show offline in place of any page not visited yet
  scope.addEventListener("install", event => {
    event.waitUntil(serially(() => revalidate("/", fetchPage("/"))).then(() => scope.skipWaiting()))
  })

  scope.addEventListener("activate", event => {
    event.waitUntil(
      serially(async () => {
        for (const name of (await scope.caches.keys()).filter(name => name !== CACHE && name !== REMINDERS))
          await scope.caches.delete(name)
        await scope.clients.claim()
        await prune(await open(), live)
      })
    )
  })

  // A page asks for its copy to be revalidated, as on coming back into view, since a window that never navigates
  // would otherwise never learn of a newer build. The copy is fetched at once, as a navigation's is, and taken in
  // when the queue reaches it
  scope.addEventListener("message", event => {
    const { revalidate: path } = Object(event.data) as { revalidate?: unknown }
    if (typeof path !== "string")
      return
    const page = pageOf(new URL(path, scope.location.origin).pathname)
    const fresh = fetchPage(page)
    // Its failure is handled by revalidate, however long that waits in the queue
    fresh.catch(() => {})
    event.waitUntil(serially(() => revalidate(page, fresh)).catch(() => {}))
  })

  scope.addEventListener("fetch", event => {
    const { request } = event
    const url = new URL(request.url)
    // The API is live, so it's never cached
    if (request.method !== "GET" || url.origin !== scope.location.origin || url.pathname.startsWith("/api/"))
      return

    // Pages: the cached copy right away, revalidated behind it. Without one, or without a cache that opens, the
    // network's. A captive portal's page is skipped for the cached home page when there is one. The network's is the
    // page itself, as a revalidation asks for it, never the address opened: a pin's, or one of the map's pages, is the
    // page with that link's preview in its head (worker/preview.mts), which isn't the page to keep
    if (request.mode === "navigate") {
      const page = pageOf(url.pathname)
      const fresh = fetchPage(new URL(page, url).href)
      event.waitUntil(serially(() => revalidate(page, fresh)).catch(() => {}))
      event.respondWith(
        open()
          .catch(() => undefined)
          .then(async cache =>
            await cache?.match(page) ??
            await fresh.then(({ response, isForeign }) => isForeign ? undefined : response, () => undefined) ??
            await cache?.match("/") ??
            (await fresh).response
          )
      )
    }
    // Icons and the manifest: fresh when online, cached when not
    else if (isBrandAsset(url.pathname))
      event.respondWith(
        scope.fetch(request, { cache: "no-cache" })
          .then(response => {
            event.waitUntil(store(request, response.clone()))
            return response
          })
          .catch(async () => (await (await open()).match(request, ANY))!)
      )
    // Hashed files (code, data, the map's style and tiles, the dining, course and prerequisites files): cache first,
    // filled on first use. Nothing else on the origin is kept, so the cache stays bounded by what's published
    else if (isHashed(url.pathname)) {
      const answer = cachedFirst(event)
      event.respondWith(answer)
      event.waitUntil(answer.then(
        response => response.status === 404 || response.status === 410 ? recover(event.clientId) : undefined,
        () => recover(event.clientId)
      ).catch(() => {}))
    }
  })
}
