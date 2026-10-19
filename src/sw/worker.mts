// Offline first: every page, its code, and its data come from the cache at once, and the network is asked behind
// them. A page's head is its release manifest (src/shell/manifest.mts): a newer copy is kept only once everything
// it names is confirmed kept, so it opens whole offline, and the pages' windows are told, to swap in its data or
// reload for its code. Hashed files never change, so they're kept until no generation needs them (retention.mts);
// the icons and the manifest keep their names, so they're fetched fresh; live data is never cached.
//
// Two contracts, kept apart: answering a request is best effort about the cache, so a put that fails, a full quota,
// or a cache that won't open never fails a response; staging a release is strict, so a file that can't be kept, that
// answers as something other than what its name says, or that doesn't arrive in time, keeps the release from being
// promoted. Neither holds up the other's writes for long: whatever stalls is given up on at a deadline

import { type Build, type Generation, buildOf, closureOf, isOlder, isSameBuild, retainOf } from "../shell/manifest.mts"
import { TILES_FOLDER } from "../map/tiles.mts"
import { STYLE_ROOT } from "../map/style.mts"
import { type CacheLike, ANY, deleteWhere, generationOf, isBrandAsset, isHashed, pageOf, prune } from "./retention.mts"

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

// Named anew when what's kept changes meaning, as it did when pages began naming their data, so activating lets go
// of every older cache: the first worker's pages named only their code, which loaded their data by URL, so what one
// needs can't be told, and it's fetched afresh like a page not visited yet
const CACHE = "app-v2"
/** Where a page's previous generation is kept, beside its current one, for windows that can't say they run it */
const PREVIOUS = "?gen=prev"
/** How long windows get to say what they run; one that can't, as frozen or in the back-forward cache, is covered by its page's previous generation */
const CENSUS_MS = 1000
/** How long a page, a staging's files, or a file kept behind an answer may take, bodies and all, as the page's own loads may */
const DEADLINE_MS = 60_000

/** A controller that aborts at the deadline, if nothing aborts it first */
const deadline = () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException("It took too long", "TimeoutError")), DEADLINE_MS)
  return controller
}

/**
 * What a file's name says its type must be, which what answers in its place with a 200, a sign-in page or a host's
 * error, isn't; anything else only mustn't be a page
 */
const TYPE_OF: [name: RegExp, type: RegExp][] = [[/\.m?js$/, /javascript/], [/\.css$/, /css/], [/\.json$/, /json/]]

/**
 * Whether a response passes for the file its name says, by its status and type, to keep at a URL that never changes:
 * a check of the transport, against what answers in a file's place, not of its bytes
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

  // Windows already sent to their page afresh, so one whose page fails again isn't sent round and round
  const reloaded = new Set<string>()
  /**
   * Sends a window whose file is gone to its page afresh, when it's a page too old to answer what it runs, as one from
   * before the worker kept what each page names, whose code has no way to recover. A page that answers retries its own
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
  // The rungs surrendered in the storm of quota failures under way, which lasts until a put succeeds or a page is
  // next taken in: every put failing in it shares each rung's surrender, under way or done, rather than climbing one
  // of its own
  let storm: Promise<void>[] = []

  /** Keeps a response if there's room, making room a rung at a time if there isn't: whether it's kept */
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

  // Every write to the cache, and every pruning, happens one at a time on this queue: one page is taken in at a
  // time, so what one brings in is never mistaken for leftovers by another's pruning, and no file is kept while a
  // pruning is under way. Reads, which answer requests, don't wait for it
  let queue: Promise<unknown> = Promise.resolve()
  const serially = (task: () => Promise<unknown>) =>
    queue = queue.then(task, task)

  /**
   * Keeps a response behind the answer, if it's whole and the cache allows, which never fails the answer. A body
   * that stalls holds the queue only until the deadline: a put that lands after it only adds a file that never
   * changes, for pruning to let go of if nothing needs it
   */
  const store = (request: Request, response: Response) =>
    isKeepable(new URL(request.url).pathname, response)
      ? serially(() => open().then(cache => Promise.race([
        keep(cache, request, response),
        new Promise(resolve => setTimeout(resolve, DEADLINE_MS))
      ]))).catch(() => {})
      : Promise.resolve()

  /**
   * A hashed file: the copy we have, unless asked past it with cache: "reload", as a page asks again for a file
   * that didn't fit, else the network's, kept behind the answer, and the copy we have after all if the network
   * can't answer
   */
  const cachedFirst = async (event: FetchLike) => {
    const { request } = event
    const copy = await open().then(cache => cache.match(request, ANY)).catch(() => undefined)
    if (copy && request.cache !== "reload")
      return copy
    const response = await scope.fetch(request).catch(error => copy ?? Promise.reject(error))
    if (response !== copy)
      event.waitUntil(store(request, response.clone()))
    return response
  }

  /**
   * Every task done, the rest called off at the first failure, which is thrown once all have settled, so nothing of
   * a failed staging outlives it
   */
  const all = async (tasks: Promise<unknown>[], controller: AbortController) => {
    await Promise.allSettled(tasks.map(task => task.catch(error => controller.abort(error))))
    if (controller.signal.aborted)
      throw controller.signal.reason
  }

  /**
   * A file in the cache, fetched and confirmed kept if it isn't, failing if it can't be, isn't what its name says,
   * or is called off before it's kept
   */
  const ensure = async (cache: CacheLike, asset: string, signal: AbortSignal) => {
    if (await cache.match(asset, ANY))
      return
    const response = await scope.fetch(asset, { signal })
    if (!isKeepable(asset, response))
      throw new Error(`${response.status} ${response.headers.get("content-type")} from ${asset}`)
    if (!await keep(cache, asset, response))
      throw new Error(`Couldn't keep ${asset}`)
  }

  /**
   * Everything a generation needs in the cache: its build's code and data, and what its data files say they can't
   * work without, which it then retains, so no pruning meanwhile lets go of any of it, all by the deadline
   */
  const stage = async (cache: CacheLike, generation: Generation) => {
    const controller = deadline()
    const ensureAll = (assets: string[]) => all(assets.map(asset => ensure(cache, asset, controller.signal)), controller)
    await ensureAll(closureOf(generation.build))
    generation.retain = (await generationOf(cache, generation.build)).retain
    await ensureAll(generation.retain.required)
  }

  /**
   * The network's own copy of a page, asked past the browser's cache, with its HTML and build if it's one of ours.
   * Anything that isn't a page, like an error, passes through, as does one of ours reached by a redirect, like /map
   * to /map/, which is kept under its own path when that's visited; but a page without a release is a captive
   * portal's sign-in or the like, answering in place of ours. One that hasn't arrived whole by the deadline failed
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
   * Takes in the network's copy of a page, fetched behind the one served. One published before the copy kept, as
   * from an edge not yet caught up, is left alone, and the same build again changes nothing. A newer copy
   * is kept only once everything it needs is confirmed kept, with the copy before it as the page's previous
   * generation, and then sent to the page's open windows, which swap in its data, or reload for its code once out of
   * view, and what no generation needs any more is let go
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
    // Taking a page in is a fresh try at making room, whatever a storm before it gave up on
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

  // The home page is kept from the start, whole, to show offline in place of any page not visited yet
  scope.addEventListener("install", event => {
    event.waitUntil(serially(() => revalidate("/", fetchPage("/"))).then(() => scope.skipWaiting()))
  })

  scope.addEventListener("activate", event => {
    event.waitUntil(
      serially(async () => {
        for (const name of (await scope.caches.keys()).filter(name => name !== CACHE))
          await scope.caches.delete(name)
        await scope.clients.claim()
        await prune(await open(), live)
      })
    )
  })

  // A page asks for its own copy to be checked, as on coming back into view, since a window that never navigates
  // would otherwise never learn of a newer build: the copy is fetched at once, as a navigation's is, and taken in
  // in turn
  scope.addEventListener("message", event => {
    const { revalidate: path } = Object(event.data) as { revalidate?: unknown }
    if (typeof path !== "string")
      return
    const page = pageOf(new URL(path, scope.location.origin).pathname)
    const fresh = fetchPage(page)
    // Its failure is for the revalidation to find, however long that waits its turn
    fresh.catch(() => {})
    event.waitUntil(serially(() => revalidate(page, fresh)).catch(() => {}))
  })

  scope.addEventListener("fetch", event => {
    const { request } = event
    const url = new URL(request.url)
    // The API is live, so it's never cached here
    if (request.method !== "GET" || url.origin !== scope.location.origin || url.pathname.startsWith("/api/"))
      return

    // Pages: the copy we have right away, checked behind it. Without one, or without a cache that opens, the
    // network's, though not a captive portal's in place of ours while there's the home page to show instead, and
    // failing that the home page
    if (request.mode === "navigate") {
      const page = pageOf(url.pathname)
      const fresh = fetchPage(url.href)
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
    // The hashed files, code, data, the map's style and tiles, and the dining files: cached first, filled on first
    // use. Nothing else of the origin's is ours to keep, so what the cache can hold stays bounded by what's published
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
