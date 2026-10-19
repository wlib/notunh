// The service worker run against a world of its own: in-memory caches, a network that answers as told and can
// be offline, a quota that can be full, for every put or only some, windows open at paths that say what they run
// when asked, and timers faked, so the worker can be restarted, driven step by step, and left to settle

import { vi } from "vitest"
import type { Generation } from "../../src/shell/manifest.mts"
import { type Scope, start } from "../../src/sw/worker.mts"
import { headOf } from "./page.mts"

export const ORIGIN = "https://notunh.app"

/**
 * A message channel that delivers in a microtask: a window's answer to the worker's census arrives at once, as it
 * does in a browser against a real second, rather than in a turn of the event loop the faked clock could overtake
 */
type Port = { onmessage?: (event: { data: unknown }) => void, other?: Port, postMessage: (data: unknown) => void, close: () => void }
class MicrotaskChannel {
  port1 = this.port()
  port2 = this.port()
  private port() {
    const port: Port = { postMessage: data => queueMicrotask(() => port.other?.onmessage?.({ data })), close: () => {} }
    return port
  }
  constructor() {
    this.port1.other = this.port2
    this.port2.other = this.port1
  }
}
vi.stubGlobal("MessageChannel", MicrotaskChannel)
/** The cache the worker keeps now, and the one the worker before it kept */
export const CACHE = "app-v2"
export const OLD_CACHE = "app-v1"

/** A page's HTML as served, naming its code and data, from a release */
export const page = (code: string[], data: Record<string, string> = {}, release?: string) =>
  new Response(`<!doctype html><html>${headOf(data, code, release)}<body></body></html>`, { headers: { "content-type": "text/html" } })

/** A file as the origin serves it, typed by its name, as a page is text/html */
export const file = (path: string, body = path) =>
  new Response(body, { headers: { "content-type": typeOf(path) } })

const typeOf = (path: string) =>
  /\.m?js$/.test(path) ? "text/javascript" :
  path.endsWith(".css")  ? "text/css" :
  path.endsWith(".json") ? "application/json" :
  path.endsWith(".png")  ? "image/png" :
  path.endsWith(".pbf")  ? "application/x-protobuf" :
                           "application/octet-stream"

/** A window open at a path, answering the worker's census with what it runs, unless it's silent, as frozen */
export type Window = {
  path:        string,
  generation?: Generation,
  isSilent?:   boolean
}

/** A cache key: the path with its query, as the worker keeps a page's previous generation under one */
export const keyOf = (request: RequestInfo | URL) => {
  const url = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url, ORIGIN)
  return url.pathname + url.search
}

export type Network = (path: string, init?: RequestInit) => Promise<Response>

export const worker = (network: Network, windows: Window[] = [], { isFull = () => false }: { isFull?: (key: string) => boolean } = {}) => {
  /** Every cache on the origin, by name, each its responses by key */
  const stores = new Map<string, Map<string, Response>>([[CACHE, new Map()]])
  /** How many times a cache was listed, as the worker does to let go of anything */
  let listings = 0
  const cacheOf = (entries: Map<string, Response>) => ({
    keys:   async () => (listings++, [...entries.keys()].map(key => new Request(ORIGIN + key))),
    match:  async (request: RequestInfo | URL) => entries.get(keyOf(request))?.clone(),
    put:    async (request: RequestInfo | URL, response: Response) => {
      if (isFull(keyOf(request)))
        throw new DOMException("The quota has been exceeded", "QuotaExceededError")
      entries.set(keyOf(request), response)
    },
    delete: async (request: RequestInfo | URL) => entries.delete(keyOf(request))
  })
  const caches = {
    open:   async (name: string) => cacheOf(stores.get(name) ?? stores.set(name, new Map()).get(name)!),
    keys:   async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name)
  }
  const entries = stores.get(CACHE)!

  let listeners = new Map<string, (event: never) => void>()
  /** What each window was sent, by its path, and what the cache held then */
  const messages: { window: string, page: string, cached: string[] }[] = []
  /** How many times the windows were looked up, to be told or asked what they run */
  let censuses = 0
  /** The windows the worker sent to their page afresh, by path */
  const navigated: string[] = []
  const clientOf = (window: Window) => ({
    id:  window.path,
    url: ORIGIN + window.path,
    navigate: async (url: string) => void navigated.push(new URL(url).pathname),
    postMessage: (message: { page?: string, census?: boolean }, transfer: MessagePort[] = []) => {
      if (typeof message.page === "string")
        messages.push({ window: window.path, page: message.page, cached: [...entries.keys()] })
      if (message.census) {
        const [port] = transfer
        if (!window.isSilent)
          port.postMessage(window.generation)
        setImmediate(() => port.close())
      }
    }
  })
  const clients = {
    claim: async () => {},
    get: async (id: string) => windows.filter(window => window.path === id).map(clientOf)[0],
    matchAll: async () => (censuses++, windows.map(clientOf))
  }
  const fetched: string[] = []
  /** The worker running now: a killed one's fetches and cache operations never answer, as its script is gone */
  let running: Scope | undefined
  const scopeOf = (): Scope => {
    const whileRunning = <T,>(f: () => Promise<T>) => running === scope ? f() : new Promise<T>(() => {})
    const scope: Scope = {
      addEventListener: (type: string, listener: (event: never) => void) => void listeners.set(type, listener),
      skipWaiting: async () => {},
      clients,
      caches: { ...caches, open: name => whileRunning(() => caches.open(name)) },
      fetch: (input: Request | string, init?: RequestInit) => whileRunning(() => {
        const path = keyOf(input)
        fetched.push(path)
        return network(path, typeof input === "string" ? init : { cache: input.cache, ...init })
      }),
      location: { origin: ORIGIN }
    }
    return scope
  }
  /** Starts the worker afresh, as the browser does after killing it, with the caches as they were and nothing else */
  const restart = () => {
    listeners = new Map()
    start(running = scopeOf())
  }
  restart()

  /** What the worker goes on to do for an event, and once it's done with it all */
  const dispatch = (type: "install" | "activate" | "message", event: object) => {
    const waits: Promise<unknown>[] = []
    listeners.get(type)!({ ...event, waitUntil: (wait: Promise<unknown>) => void waits.push(wait) } as never)
    const pending = Promise.all(waits)
    return { pending, get done() { return settled(pending) } }
  }
  /** What the worker answers for a request, what it goes on to do behind it, and once it's done with it all */
  const request = (path: string, mode = "no-cors", cache: RequestCache = "default", clientId?: string) => {
    let response: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    listeners.get("fetch")!({
      request: { url: path.startsWith("/") ? ORIGIN + path : path, method: "GET", mode, cache },
      clientId,
      respondWith: (answer: Promise<Response>) => response = answer,
      waitUntil: (wait: Promise<unknown>) => void waits.push(wait)
    } as never)
    const pending = response?.catch(() => undefined).then(() => Promise.all(waits)) ?? Promise.resolve([])
    return { response: response!, pending, get done() { return settled(pending) } }
  }
  return {
    entries,
    stores,
    messages,
    navigated,
    fetched,
    windows,
    restart,
    request,
    censuses: () => censuses,
    listings: () => listings,
    navigate:   (path: string) => request(path, "navigate"),
    install:    () => dispatch("install", {}),
    activate:   () => dispatch("activate", {}),
    message:    (data: unknown) => dispatch("message", { data }),
    /** The paths cached, sorted */
    paths: () => [...entries.keys()].sort(),
    /** Whether a path is cached */
    has:   (path: string) => entries.has(path)
  }
}

// Turns of the event loop a promise gets to settle before it's taken as hung, as one a killed worker was waiting on
const TURNS = 1000

/**
 * A promise once it settles, with the faked clock run forward as long as it takes, as the worker's waits for windows
 * time out; anything the fake timers don't catch gets a turn of the real event loop
 */
export const settled = async <T,>(promise: Promise<T>): Promise<T> => {
  let isDone = false
  promise.then(() => isDone = true, () => isDone = true)
  for (let turn = 0; !isDone && turn < TURNS; turn++) {
    await new Promise(resolve => setImmediate(resolve))
    // Once the test is over and the timers are real again, there's nothing left to wait for
    if (!isDone && !vi.isFakeTimers())
      break
    if (!isDone)
      await vi.advanceTimersByTimeAsync(1000)
  }
  return promise
}
