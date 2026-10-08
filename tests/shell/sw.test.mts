import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const ORIGIN = "https://notunh.app"
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
})

const pathOf = (request: string | { url: string }) =>
  new URL(typeof request === "string" ? request : request.url, ORIGIN).pathname

const page = (assets: string[]) =>
  new Response(`<!doctype html>${assets.map(asset => `<script src="${asset}"></script>`).join("")}`, { headers: { "content-type": "text/html" } })

/** The service worker, run against an in-memory cache and a network that answers as told */
const worker = (network: (path: string) => Promise<Response>) => {
  const entries = new Map<string, Response>()
  const cache = {
    keys: async () => [...entries.keys()].map(path => ({ url: ORIGIN + path })),
    match: async (request: string | { url: string }) => entries.get(pathOf(request))?.clone(),
    put: async (request: string | { url: string }, response: Response) => void entries.set(pathOf(request), response),
    delete: async (request: string | { url: string }) => entries.delete(pathOf(request)),
    add: async (request: string) => void entries.set(pathOf(request), await network(pathOf(request)))
  }
  const listeners = new Map<string, (event: unknown) => void>()
  runInNewContext(source, {
    self: { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) },
    caches: { open: async () => cache, match: cache.match },
    fetch: (request: string | { url: string }) => network(pathOf(request)),
    location: { origin: ORIGIN },
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    URL
  })
  /** What the worker answers for a request, and once it's done with it */
  const request = (path: string, mode = "no-cors") => {
    let response: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    listeners.get("fetch")!({
      request: { url: ORIGIN + path, method: "GET", mode },
      respondWith: (answer: Promise<Response>) => response = answer,
      waitUntil: (wait: Promise<unknown>) => waits.push(wait)
    })
    return { response: response!, done: response!.then(() => Promise.all(waits)) }
  }
  return { entries, request, navigate: (path: string) => request(path, "navigate") }
}

const never = () => new Promise<Response>(() => {})
const textOf = async (response: Promise<Response>) => (await response).text()

test("a page comes fresh when the network answers, and is kept", async () => {
  const sw = worker(async () => page(["/assets/map/index-AAAAAAAA.js"]))
  const { response, done } = sw.navigate("/map/")
  expect(await textOf(response)).toContain("index-AAAAAAAA")
  await done
  expect(sw.entries.has("/map/")).toBe(true)
})

test("a page waits 3 s for the network before the copy we have, and keeps the late answer", async () => {
  let answer: (response: Response) => void = () => {}
  const sw = worker(() => new Promise(resolve => answer = resolve))
  sw.entries.set("/map/", page(["/assets/old-AAAAAAAA.js"]))
  sw.entries.set("/assets/old-AAAAAAAA.js", new Response(""))
  const { response, done } = sw.navigate("/map/")
  await vi.advanceTimersByTimeAsync(2_999)
  let isAnswered = false
  response.then(() => isAnswered = true)
  await vi.advanceTimersByTimeAsync(0)
  expect(isAnswered).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await textOf(response)).toContain("old-AAAAAAAA")
  answer(page(["/assets/new-BBBBBBBB.js"]))
  await done
  expect(await sw.entries.get("/map/")!.clone().text()).toContain("new-BBBBBBBB")
  // The old copy served meanwhile may still be loading its assets
  expect(sw.entries.has("/assets/old-AAAAAAAA.js")).toBe(true)
})

test("a page we don't have yet waits for the network rather than showing the home page", async () => {
  let answer: (response: Response) => void = () => {}
  const sw = worker(() => new Promise(resolve => answer = resolve))
  sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  const { response } = sw.navigate("/map/")
  await vi.advanceTimersByTimeAsync(10_000)
  answer(page(["/assets/map-BBBBBBBB.js"]))
  expect(await textOf(response)).toContain("map-BBBBBBBB")
})

test("offline, a page is the copy we have, else the home page", async () => {
  const sw = worker(() => Promise.reject(new TypeError("Load failed")))
  sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  expect(await textOf(sw.navigate("/map/").response)).toContain("home-AAAAAAAA")
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  expect(await textOf(sw.navigate("/map/").response)).toContain("map-AAAAAAAA")
})

test("every laundry room is the laundry page, kept once, and offline from any room", async () => {
  const sw = worker(async () => page(["/assets/laundry-AAAAAAAA.js"]))
  await sw.navigate("/laundry/adams-tower/").done
  expect([...sw.entries.keys()]).toEqual(["/laundry/"])

  const offline = worker(() => Promise.reject(new TypeError("Load failed")))
  offline.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  offline.entries.set("/laundry/", page(["/assets/laundry-AAAAAAAA.js"]))
  expect(await textOf(offline.navigate("/laundry/hunter-hall/").response)).toContain("laundry-AAAAAAAA")
})

test("a captive portal's page is never served in place of ours, or kept as ours", async () => {
  const portal = () => new Response("<!doctype html><form>Sign in to UNH-Guest</form>", { headers: { "content-type": "text/html" } })
  const sw = worker(async () => portal())
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  const { response, done } = sw.navigate("/map/")
  expect(await textOf(response)).toContain("map-AAAAAAAA")
  await done
  expect(await sw.entries.get("/map/")!.clone().text()).toContain("map-AAAAAAAA")

  // With nothing at all cached, the portal is better than nothing
  const fresh = worker(async () => portal())
  expect(await textOf(fresh.navigate("/map/").response)).toContain("UNH-Guest")
})

test("redirects and errors pass straight through, and aren't kept", async () => {
  const sw = worker(async path => path === "/map" ? Response.redirect(`${ORIGIN}/map/`, 301) : new Response("Not found", { status: 404 }))
  expect((await sw.navigate("/map").response).status).toBe(301)
  expect((await sw.navigate("/nowhere/").response).status).toBe(404)
  await vi.advanceTimersByTimeAsync(0)
  expect(sw.entries.size).toBe(0)
})

test("the schedule, menus, and maplibre's worker are kept one copy per name, and other assets side by side", async () => {
  const sw = worker(async path => new Response(path))
  for (const path of [
    "/assets/gtfs-AAAAAAAA.json", "/assets/gtfs-BBBB-BBB.json", "/assets/menus-AAAAAAAA.json",
    "/assets/maplibre-gl-worker-AAAAAAAA.js", "/assets/maplibre-gl-worker-BBBBBBBB.js",
    "/assets/index-AAAAAAAA.js", "/assets/index-BBBBBBBB.js"
  ])
    await sw.request(path).done
  expect([...sw.entries.keys()].sort()).toEqual([
    "/assets/gtfs-BBBB-BBB.json", "/assets/index-AAAAAAAA.js", "/assets/index-BBBBBBBB.js",
    "/assets/maplibre-gl-worker-BBBBBBBB.js", "/assets/menus-AAAAAAAA.json"
  ])
})

const PAGES = ["/", "/map/", "/dining/"]
const hash = fc.stringMatching(/^[A-Za-z0-9_-]{8}$/)
const asset = fc.tuple(fc.constantFrom("index", "bruh", "map/index", "dining/index", "maplibre-gl"), hash, fc.constantFrom("js", "css"))
  .map(([name, hash, extension]) => `/assets/${name}-${hash}.${extension}`)
const singleton = fc.tuple(fc.constantFrom("gtfs", "menus"), hash).map(([name, hash]) => `/assets/${name}-${hash}.json`)

test("once a page's build changes, only assets that some cached page names, and one copy of each singleton, are left", async () => {
  await fc.assert(fc.asyncProperty(
    fc.tuple(...PAGES.map(() => fc.uniqueArray(asset, { maxLength: 6 }))),
    fc.uniqueArray(asset, { maxLength: 6 }),
    // Our pages always name some
    fc.uniqueArray(asset, { minLength: 1, maxLength: 6 }),
    fc.uniqueArray(singleton, { maxLength: 3, selector: path => path.split("-")[0] }),
    async (named, stray, next, singletons) => {
      const sw = worker(async path => path === "/map/" ? page(next) : new Response(path))
      PAGES.forEach((path, i) => sw.entries.set(path, page(named[i])))
      for (const path of [...named.flat(), ...stray, ...singletons, "/data/dining/AAAAAAAAAAAAAAAA.json"])
        sw.entries.set(path, new Response(path))
      const before = new Set(sw.entries.keys())
      await sw.navigate("/map/").done

      const isChanged = next.join() !== named[1].join()
      const kept = new Set([...named[0], ...named[2], ...next])
      for (const path of before)
        expect(sw.entries.has(path)).toBe(
          !isChanged ||
          !path.startsWith("/assets/") ||
          kept.has(path) ||
          singletons.includes(path)
        )
    }
  ))
})
