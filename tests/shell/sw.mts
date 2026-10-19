// The service worker run against a world of its own: an in-memory cache, a network that answers as told and can
// be offline, a quota that can be full, windows open at paths that say what they run when asked, and timers faked,
// so the worker can be restarted, driven step by step, and left to settle

import { vi } from "vitest"
import type { Generation } from "../../src/shell/manifest.mts"
import { type Scope, start } from "../../src/sw/worker.mts"
import { headOf } from "./page.mts"

export const ORIGIN = "https://notunh.app"

/** A page's HTML as served, naming its code and data, from a release */
export const page = (code: string[], data: Record<string, string> = {}, release?: string) =>
  new Response(`<!doctype html><html>${headOf(data, code, release)}<body></body></html>`, { headers: { "content-type": "text/html" } })

/** A window open at a path, answering the worker's census with what it runs, unless it's silent, as frozen */
export type Window = {
  path:        string,
  generation?: Generation,
  isSilent?:   boolean
}

/** A cache key: the path with its query, as the worker keeps a page's previous generation under one */
const keyOf = (request: RequestInfo | URL) => {
  const url = new URL(typeof request === "string" ? request : request instanceof URL ? request : request.url, ORIGIN)
  return url.pathname + url.search
}

export type Network = (path: string, init?: RequestInit) => Promise<Response>

export const worker = (network: Network, windows: Window[] = [], { isFull = () => false }: { isFull?: () => boolean } = {}) => {
  const entries = new Map<string, Response>()
  const cache = {
    keys:   async () => [...entries.keys()].map(key => new Request(ORIGIN + key)),
    match:  async (request: RequestInfo | URL) => entries.get(keyOf(request))?.clone(),
    put:    async (request: RequestInfo | URL, response: Response) => {
      if (isFull())
        throw new DOMException("The quota has been exceeded", "QuotaExceededError")
      entries.set(keyOf(request), response)
    },
    delete: async (request: RequestInfo | URL) => entries.delete(keyOf(request))
  }
  /** The caches let go of, by name, as another cache of ours would be from an older worker */
  const deleted: string[] = []
  const caches = { open: async () => cache, keys: async () => ["app-v2", "app-v1"], delete: async (name: string) => (deleted.push(name), true), deleted }

  let listeners = new Map<string, (event: never) => void>()
  /** What each window was sent, by its path, and what the cache held then */
  const messages: { window: string, page: string, cached: string[] }[] = []
  /** How many times the windows were looked up, to be told or asked what they run */
  let censuses = 0
  const clients = {
    claim: async () => {},
    matchAll: async () => (censuses++, windows.map(window => ({
      url: ORIGIN + window.path,
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
    })))
  }
  const fetched: string[] = []
  const scope: Scope = {
    addEventListener: (type: string, listener: (event: never) => void) => void listeners.set(type, listener),
    skipWaiting: async () => {},
    clients,
    caches,
    fetch: (input: Request | string, init?: RequestInit) => {
      const path = keyOf(input)
      fetched.push(path)
      return network(path, init)
    },
    location: { origin: ORIGIN }
  }
  /** Starts the worker afresh, as the browser does after killing it, with the cache as it was and nothing else */
  const restart = () => {
    listeners = new Map()
    start(scope)
  }
  restart()

  const dispatch = (type: "install" | "activate" | "message", event: object) => {
    const waits: Promise<unknown>[] = []
    listeners.get(type)!({ ...event, waitUntil: (wait: Promise<unknown>) => void waits.push(wait) } as never)
    return settled(Promise.all(waits))
  }
  /** What the worker answers for a request, what it goes on to do behind it, and once it's done with it all */
  const request = (path: string, mode = "no-cors") => {
    let response: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    listeners.get("fetch")!({
      request: { url: path.startsWith("/") ? ORIGIN + path : path, method: "GET", mode },
      respondWith: (answer: Promise<Response>) => response = answer,
      waitUntil: (wait: Promise<unknown>) => void waits.push(wait)
    } as never)
    const pending = response?.catch(() => undefined).then(() => Promise.all(waits)) ?? Promise.resolve([])
    return { response: response!, pending, get done() { return settled(pending) } }
  }
  return {
    entries,
    messages,
    fetched,
    windows,
    caches,
    restart,
    request,
    censuses: () => censuses,
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

/**
 * A promise once it settles, with the faked clock run forward as long as it takes, as the worker's waits for windows
 * time out; anything the fake timers don't catch gets a turn of the real event loop
 */
export const settled = async <T,>(promise: Promise<T>): Promise<T> => {
  let isDone = false
  promise.then(() => isDone = true, () => isDone = true)
  while (!isDone) {
    await new Promise(resolve => setImmediate(resolve))
    if (!isDone)
      await vi.advanceTimersByTimeAsync(1000)
  }
  return promise
}
