import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import { type Generation, type Retain, buildOf } from "../../src/shell/manifest.mts"
import { RELEASE } from "./page.mts"
import { type Network, type Window, OLD_CACHE, file, page, worker } from "./sw.mts"
import { republished } from "../../scripts/republish.mts"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
})

const never = () => new Promise<Response>(() => {})
const offline = () => Promise.reject(new TypeError("Load failed"))
const textOf = async (response: Promise<Response>) => (await response).text()
const html = async (response: Response) => response.clone().text()
const LATER = "2026-10-19T08:00:00.000Z"

/** What a window runs: its code and data, and what its data keeps */
const generation = (code: string[], data: Record<string, string> = {}, retain: Retain = {}): Generation =>
  ({ build: { release: RELEASE, code, data }, retain: { required: [], files: [], folders: [], ...retain } })

const window = (path: string, code: string[], data?: Record<string, string>, retain?: Retain): Window =>
  ({ path, generation: generation(code, data, retain) })

//#region Serving pages

test("a page we don't have comes from the network, and is kept whole, with everything it names", async () => {
  const code = ["/assets/map/index-AAAAAAAA.js", "/assets/maplibre-gl-worker-AAAAAAAA.js", "/manifest.webmanifest"]
  const data = { gtfs: "/assets/gtfs-AAAAAAAA.json" }
  const sw = worker(async path => path === "/map/" ? page(code, data) : file(path))
  const { response, done } = sw.navigate("/map/")
  expect(await textOf(response)).toContain("index-AAAAAAAA")
  await done
  for (const path of ["/map/", ...code, ...Object.values(data)])
    expect(sw.has(path)).toBe(true)
})

test("pages taken in at once keep all they name, though one's pruning comes while another's are still coming", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.tuple(fc.nat(20), fc.nat(20), fc.nat(20)), async (isMapFirst, [home, map, gtfs]) => {
    const next = ["/assets/map-BBBBBBBB.js", "/assets/gtfs-BBBBBBBB.json"]
    const after = (ms: number, response: () => Response) => new Promise<Response>(resolve => setTimeout(() => resolve(response()), ms))
    const sw = worker(path =>
      path === "/"     ? after(home, () => page(["/assets/home-AAAAAAAA.js"], {}, LATER)) :
      path === "/map/" ? Promise.resolve(page(next, {}, LATER)) :
                         after(path.includes("gtfs") ? gtfs : map, () => file(path))
    )
    sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
    sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
    const navigations = (isMapFirst ? ["/map/", "/"] : ["/", "/map/"]).map(sw.navigate)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all(navigations.map(({ done }) => done))
    for (const path of next)
      expect(sw.has(path)).toBe(true)
  }))
})

test("a page we have comes from the cache at once, however long the network takes, which is checked behind it, past the browser's cache", async () => {
  let answer: (response: Response) => void = () => {}
  const inits: (RequestInit | undefined)[] = []
  const sw = worker((path, init) => {
    if (path !== "/map/?to=dining/philbrook")
      return Promise.resolve(file(path))
    inits.push(init)
    return new Promise(resolve => answer = resolve)
  }, [window("/map/", ["/assets/old-AAAAAAAA.js"]), { path: "/" }, { path: "/laundry/adams-tower/" }])
  sw.entries.set("/map/", page(["/assets/old-AAAAAAAA.js"], { gtfs: "/assets/gtfs-AAAAAAAA.json" }))
  const { response, done } = sw.navigate("/map/?to=dining/philbrook")
  expect(await textOf(response)).toContain("old-AAAAAAAA")
  expect(inits).toEqual([{ cache: "no-cache", signal: expect.any(AbortSignal) }])

  // The network's newer copy is kept once everything it names is. The copy before becomes the page's previous
  // generation, and only then is the newer one sent to the page's windows
  const next = page(["/assets/old-AAAAAAAA.js"], { gtfs: "/assets/gtfs-BBBBBBBB.json" }, LATER)
  answer(next.clone())
  await done
  expect(await html(sw.entries.get("/map/")!)).toContain("gtfs-BBBBBBBB")
  expect(await html(sw.entries.get("/map/?gen=prev")!)).toContain("gtfs-AAAAAAAA")
  expect(sw.messages).toEqual([{ window: "/map/", page: await next.text(), cached: expect.arrayContaining(["/map/", "/assets/old-AAAAAAAA.js", "/assets/gtfs-BBBBBBBB.json"]) }])
})

test("a newer copy isn't kept until everything it names is, so the copy we have still opens whole offline", async () => {
  const sw = worker(async path =>
    path === "/dining/"      ? page(["/assets/dining-BBBBBBBB.js", "/assets/menus-BBBBBBBB.json"], {}, LATER) :
    path.endsWith(".json") ? offline() :
                             file(path),
    [{ path: "/dining/" }]
  )
  sw.entries.set("/dining/", page(["/assets/dining-AAAAAAAA.js"]))
  await sw.navigate("/dining/").done
  expect(await html(sw.entries.get("/dining/")!)).toContain("dining-AAAAAAAA")
  expect(sw.messages).toEqual([])
})

test("the same build again tells no one and lets nothing go, however the host varies the HTML around it", async () => {
  let nonce = 0
  const varied = () => new Response(`<!doctype html><html><head><meta name="release" content="${RELEASE}"><script type="module" src="/assets/map-AAAAAAAA.js"></script><script nonce="${nonce++}"></script></head><body></body></html>`, { headers: { "content-type": "text/html" } })
  const sw = worker(async path => path === "/map/" ? varied() : file(path), [{ path: "/map/" }])
  sw.entries.set("/map/", varied())
  sw.entries.set("/assets/map-AAAAAAAA.js", new Response("a"))
  sw.entries.set("/assets/stale-ZZZZZZZZ.js", new Response("named by no page, but not this navigation's to let go"))
  for (let i = 0; i < 3; i++)
    await sw.navigate("/map/").done
  expect(sw.messages).toEqual([])
  expect(sw.has("/assets/stale-ZZZZZZZZ.js")).toBe(true)
  expect(sw.has("/map/?gen=prev")).toBe(false)
  expect(sw.censuses()).toBe(0)
})

test("the same build from a newer release is kept as the newer release, quietly", async () => {
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-AAAAAAAA.js"], {}, LATER) : file(path), [{ path: "/map/" }])
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  await sw.navigate("/map/").done
  expect(buildOf(await html(sw.entries.get("/map/")!)).release).toBe(LATER)
  expect(sw.messages).toEqual([])
})

test("a copy from an older release, as from an edge not yet caught up, is left alone", async () => {
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-AAAAAAAA.js"]) : file(path), [{ path: "/map/" }])
  sw.entries.set("/map/", page(["/assets/map-BBBBBBBB.js"], {}, LATER))
  sw.entries.set("/assets/map-BBBBBBBB.js", new Response("b"))
  await sw.navigate("/map/").done
  expect(await html(sw.entries.get("/map/")!)).toContain("map-BBBBBBBB")
  expect(sw.messages).toEqual([])
  expect(sw.has("/assets/map-AAAAAAAA.js")).toBe(false)
})

test("a build published again, as a rollback is, is taken in over a newer one, and the newer one again, as from an edge not yet caught up, is left alone", async () => {
  const LATEST = "2026-10-20T08:00:00.000Z"
  const rolledBack = page(["/assets/map-AAAAAAAA.js"])
  let served = new Response(republished(await rolledBack.text(), new Date(LATEST)), rolledBack)
  const sw = worker(async path => path === "/map/" ? served.clone() : file(path), [{ path: "/map/" }])
  sw.entries.set("/map/", page(["/assets/map-BBBBBBBB.js"], {}, LATER))
  await sw.navigate("/map/").done
  expect(buildOf(await html(sw.entries.get("/map/")!))).toMatchObject({ release: RELEASE, published: LATEST, code: ["/assets/map-AAAAAAAA.js"] })
  expect(buildOf(await html(sw.entries.get("/map/?gen=prev")!)).release).toBe(LATER)
  expect(sw.messages.length).toBe(1)
  served = page(["/assets/map-BBBBBBBB.js"], {}, LATER)
  await sw.navigate("/map/").done
  expect(await html(sw.entries.get("/map/")!)).toContain("map-AAAAAAAA")
  expect(sw.messages.length).toBe(1)
})

test("a newer laundry page is sent to every room's window, and no other", async () => {
  const sw = worker(async path => path.startsWith("/laundry/") ? page(["/assets/laundry-BBBBBBBB.js"], {}, LATER) : file(path), ["/laundry/", "/laundry/hunter-hall/", "/map/", "/"].map(path => ({ path })))
  sw.entries.set("/laundry/", page(["/assets/laundry-AAAAAAAA.js"]))
  await sw.navigate("/laundry/adams-tower/").done
  expect(sw.messages.map(({ window }) => window)).toEqual(["/laundry/", "/laundry/hunter-hall/"])
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
  const sw = worker(offline)
  sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  expect(await textOf(sw.navigate("/map/").response)).toContain("home-AAAAAAAA")
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  expect(await textOf(sw.navigate("/map/").response)).toContain("map-AAAAAAAA")
})

test("every laundry room is the laundry page, kept once, and offline from any room, even one there's no such room as", async () => {
  const sw = worker(async path => path.startsWith("/laundry/") ? page(["/assets/laundry-AAAAAAAA.js"]) : file(path))
  await sw.navigate("/laundry/adams-tower/").done
  expect(sw.paths().filter(path => path.endsWith("/"))).toEqual(["/laundry/"])

  const stale = worker(async () => new Response("Not found", { status: 404 }))
  stale.entries.set("/laundry/", page(["/assets/laundry-AAAAAAAA.js"]))
  const { response, done } = stale.navigate("/laundry/nonexistent/")
  expect((await response).status).toBe(200)
  await done

  const away = worker(offline)
  away.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  away.entries.set("/laundry/", page(["/assets/laundry-AAAAAAAA.js"]))
  expect(await textOf(away.navigate("/laundry/hunter-hall/").response)).toContain("laundry-AAAAAAAA")
})

test("a captive portal's page is never served in place of ours, or kept as ours", async () => {
  const portal = () => new Response("<!doctype html><head><script src=\"/portal.js\"></script></head><form>Sign in to UNH-Guest</form>", { headers: { "content-type": "text/html" } })
  const sw = worker(async () => portal())
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  const { response, done } = sw.navigate("/map/")
  expect(await textOf(response)).toContain("map-AAAAAAAA")
  await done
  expect(await html(sw.entries.get("/map/")!)).toContain("map-AAAAAAAA")

  // With nothing at all cached, the portal is better than nothing
  const fresh = worker(async () => portal())
  expect(await textOf(fresh.navigate("/map/").response)).toContain("UNH-Guest")
})

test("redirects and errors pass straight through, and aren't kept", async () => {
  const sw = worker(async path => path === "/map" ? Response.redirect("https://notunh.app/map/", 301) : new Response("Not found", { status: 404 }))
  expect((await sw.navigate("/map").response).status).toBe(301)
  expect((await sw.navigate("/nowhere/").response).status).toBe(404)
  await vi.advanceTimersByTimeAsync(0)
  expect(sw.entries.size).toBe(0)
})

test("our own page reached by a redirect, as /map is to /map/, is served as it is, not the home page, and isn't kept under the path asked for", async () => {
  const sw = worker(async path => {
    if (path !== "/map")
      return file(path)
    // As the browser hands a followed redirect back
    return Object.defineProperty(page(["/assets/map-AAAAAAAA.js"]), "redirected", { value: true })
  })
  sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  const { response, done } = sw.navigate("/map")
  expect(await textOf(response)).toContain("map-AAAAAAAA")
  await done
  expect(sw.paths()).toEqual(["/"])
})

test("a page asking for its copy to be checked gets the same as a navigation", async () => {
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], {}, LATER) : file(path), [{ path: "/map/?to=x" }])
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  await sw.message({ revalidate: "/map/?to=x" }).done
  expect(await html(sw.entries.get("/map/")!)).toContain("map-BBBBBBBB")
  expect(sw.has("/assets/map-BBBBBBBB.js")).toBe(true)
  expect(sw.messages.map(({ window }) => window)).toEqual(["/map/?to=x"])
  // Anything else a page might say is ignored
  await sw.message({ something: "else" }).done
  await sw.message(undefined).done
})

/** A page as the first worker kept it: naming only its code, without a release, as that code loaded its data by URL */
const v1Page = (code: string) =>
  new Response(`<!doctype html><html><head><script type="module" src="${code}"></script></head><body></body></html>`, { headers: { "content-type": "text/html" } })

test("installing keeps the home page whole, and activating lets go of every older cache, and of what nothing needs", async () => {
  let isOffline = false
  const sw = worker(async path =>
    isOffline ? offline() :
    path === "/" ? page(["/assets/home-AAAAAAAA.js"]) :
    path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], { gtfs: "/assets/gtfs-BBBBBBBB.json" }, LATER) :
    path.includes("OLDOLDOL") ? new Response("Not found", { status: 404 }) :
    file(path), [{ path: "/map/" }])
  sw.entries.set("/assets/stale-ZZZZZZZZ.js", new Response("stale"))
  // As the first worker kept them: pages, their code, and the data and maplibre's worker that code loaded by URL
  sw.stores.set(OLD_CACHE, new Map<string, Response>([
    ["/map/", v1Page("/assets/map-OLDOLDOL.js")],
    ["/dining/", v1Page("/assets/dining-OLDOLDOL.js")],
    ["/assets/map-OLDOLDOL.js", new Response("old code")],
    ["/assets/gtfs-OLDOLDOL.json", new Response("old data")],
    ["/assets/maplibre-gl-worker-OLDOLDOL.js", new Response("old worker")]
  ]))
  await sw.install().done
  expect(sw.has("/")).toBe(true)
  expect(sw.has("/assets/home-AAAAAAAA.js")).toBe(true)
  await sw.activate().done
  expect([...sw.stores.keys()]).toEqual(["app-v2"])
  expect(sw.paths()).toEqual(["/", "/assets/home-AAAAAAAA.js"])
  // What one of the first worker's pages needs can't be told from it. So it isn't served without its data, but
  // fetched afresh and kept whole
  const { response, done } = sw.navigate("/map/")
  expect(await textOf(response)).toContain("map-BBBBBBBB")
  await done
  expect(sw.has("/assets/gtfs-BBBBBBBB.json")).toBe(true)
  // Offline, one not visited since is the home page
  isOffline = true
  expect(await textOf(sw.navigate("/dining/").response)).toContain("home-AAAAAAAA")
})

test("a page from before the upgrade whose file is gone is sent to its page afresh, once, and a page that answers is left to retry its own", async () => {
  let isOffline = false
  const sw = worker(async path =>
    isOffline ? offline() :
    path.includes("OLDOLDOL") ? new Response("Not found", { status: 404 }) :
    file(path), [{ path: "/map/", isSilent: true }, window("/dining/", ["/assets/dining-AAAAAAAA.js"])])
  await sw.activate().done
  // Its code loads its data by URL, which the upgrade let go of, and the origin no longer has
  await sw.request("/assets/gtfs-OLDOLDOL.json", "cors", "default", "/map/").done
  expect(sw.navigated).toEqual(["/map/"])
  // Failing again, as offline before the fresh page arrives, doesn't send it round and round
  isOffline = true
  await sw.request("/assets/maplibre-gl-worker-OLDOLDOL.js", "cors", "default", "/map/").done
  expect(sw.navigated).toEqual(["/map/"])
  await sw.request("/assets/menus-OLDOLDOL.json", "cors", "default", "/dining/").done
  expect(sw.navigated).toEqual(["/map/"])
})

//#endregion

//#region Serving files

test("the API, other origins, and anything of ours that isn't published as a hashed file or a page are never answered or kept", async () => {
  const sw = worker(async path => file(path))
  for (const url of ["/api/laundry/rooms", "https://tiles.openfreemap.org/planet/1/0/0.pbf", "https://api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh/vehicles", "/robots.txt", "/map/anything.json?x=1"]) {
    const { response } = sw.request(url)
    expect(response).toBeUndefined()
  }
  expect(sw.entries.size).toBe(0)
})

const hash = fc.stringMatching(/^[A-Za-z0-9_-]{8}$/)
const asset = fc.tuple(fc.constantFrom("index.js", "bruh.js", "map/index.js", "maplibre-gl-worker.js", "maplibre-gl.css", "gtfs.json", "menus.json"), hash)
  .map(([file, hash]) => `/assets/${file.replace(".", `-${hash}.`)}`)
const VERSIONS = ["2026-10-03", "2026-10-10", "2026-10-17"]
const tile = fc.tuple(fc.constantFrom(...VERSIONS), fc.constantFrom("openmaptiles", "campus"), fc.integer({ min: 14, max: 16 }), fc.nat(3), fc.nat(3))
  .map(([version, set, z, x, y]) => `/data/map/tiles/${version}/${set}/${z}/${x}/${y}.pbf`)
const styleFile = fc.tuple(fc.constantFrom("AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"), fc.constantFrom("style.json", "sprite.json", "sprite@2x.png", "fonts/Noto%20Sans%20Bold/0-255.pbf"))
  .map(([folder, file]) => `/data/map/${folder}/${file}`)
const food = hash.map(hash => `/data/dining/${hash}${hash}.json`)
const hashed = fc.oneof(asset, tile, styleFile, food)

test("hashed files, code, data, tiles, style, and dining alike, come from the cache with no refresh behind them, and are filled on first use, never letting go of another", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(hashed, { maxLength: 8 }), fc.array(hashed, { minLength: 1, maxLength: 8 }), async (cached, requested) => {
    const sw = worker(async path => file(path, `new ${path}`))
    for (const path of cached)
      sw.entries.set(path, new Response(`old ${path}`))
    for (const path of requested) {
      const { response, done } = sw.request(path)
      expect(await textOf(response)).toBe(`${cached.includes(path) ? "old" : "new"} ${path}`)
      await done
    }
    expect(sw.paths()).toEqual([...new Set([...cached, ...requested])].sort())
    expect(sw.fetched).toEqual([...new Set(requested.filter(path => !cached.includes(path)))])
  }))
})

test("icons and the manifest are fresh when online, and the copy we have when not", async () => {
  let version = "new"
  const sw = worker(async path => version === "offline" ? offline() : file(path, `${version} ${path}`))
  for (const path of ["/icon.svg", "/icon-180.png", "/icon-512-maskable.png", "/manifest.webmanifest"]) {
    sw.entries.set(path, new Response(`old ${path}`))
    expect(await textOf(sw.request(path).response)).toBe(`new ${path}`)
    version = "offline"
    expect(await textOf(sw.request(path).response)).toBe(`new ${path}`)
    version = "new"
  }
})

//#endregion

//#region Retention

const PAGES = ["/", "/map/", "/dining/"]

test("after a newer page comes in, what's kept is every cached page's current and previous generation and what the windows answering run, and nothing else", async () => {
  await fc.assert(fc.asyncProperty(
    fc.tuple(...PAGES.map(() => fc.uniqueArray(asset, { maxLength: 4 }))),
    fc.tuple(...PAGES.map(() => fc.option(fc.uniqueArray(asset, { maxLength: 4 }), { nil: undefined }))),
    fc.uniqueArray(asset, { maxLength: 4 }),
    fc.uniqueArray(asset, { minLength: 1, maxLength: 4 }),
    fc.array(fc.record({ path: fc.constantFrom(...PAGES, "/laundry/"), code: fc.uniqueArray(asset, { maxLength: 3 }), isSilent: fc.boolean() }), { maxLength: 3 }),
    async (named, previous, stray, next, open) => {
      const windows = open.map(({ path, code, isSilent }) => ({ ...window(path, code), isSilent }))
      const sw = worker(async path => path === "/map/" ? page(next, {}, LATER) : file(path), windows)
      PAGES.forEach((path, i) => {
        sw.entries.set(path, page(named[i]))
        if (previous[i])
          sw.entries.set(`${path}?gen=prev`, page(previous[i]))
      })
      fc.pre(next.join() !== named[1].join())
      for (const path of [...named.flat(), ...previous.flatMap(code => code ?? []), ...stray, ...open.flatMap(({ code }) => code)])
        sw.entries.set(path, file(path))
      const before = new Set(sw.entries.keys())
      await sw.navigate("/map/").done

      // The map page's previous generation is the one it just had, and its earlier one has gone
      const kept = new Set([
        ...named.flat(), ...next, ...previous.flatMap((code, i) => i === 1 ? [] : code ?? []),
        ...open.flatMap(({ code, isSilent }) => isSilent ? [] : code)
      ])
      for (const path of new Set([...before, ...next]))
        if (path.startsWith("/assets/"))
          expect(sw.has(path)).toBe(kept.has(path))
      expect(await html(sw.entries.get("/map/?gen=prev")!)).toBe(await html(page(named[1])))
    }
  ))
})

test("an open tab's build stays whole while other tabs bring in newer builds of its page and others", async () => {
  // Map A is open, a newer map B comes in while the A tab stays open, then the home page is navigated to unchanged
  const old = "/assets/map-AAAAAAAA.js"
  const sw = worker(async path =>
    path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], {}, LATER) :
    path === "/"     ? page(["/assets/home-AAAAAAAA.js"]) :
                       file(path),
    [window("/map/", [old])]
  )
  sw.entries.set("/map/", page([old]))
  sw.entries.set(old, new Response("a"))
  sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"]))
  sw.entries.set("/assets/home-AAAAAAAA.js", new Response("home"))
  await sw.navigate("/map/").done
  expect(sw.has(old)).toBe(true)
  await sw.navigate("/").done
  expect(sw.has(old)).toBe(true)

  // Pruning for any reason asks the tab, which answers for itself
  await sw.activate().done
  expect(sw.has(old)).toBe(true)
  // A tab that can't answer is covered as far back as its page's previous generation, and no further
  sw.windows[0].isSilent = true
  await sw.activate().done
  expect(sw.has(old)).toBe(true)
  sw.entries.set("/map/", page(["/assets/map-CCCCCCCC.js"], {}, "2026-10-20T08:00:00.000Z"))
  await sw.message({ revalidate: "/map/" }).done
  expect(sw.has(old)).toBe(true)
  sw.entries.set("/assets/map-CCCCCCCC.js", new Response("c"))
  sw.entries.set("/map/?gen=prev", page(["/assets/map-BBBBBBBB.js"], {}, LATER))
  await sw.activate().done
  expect(sw.has(old)).toBe(false)
})

test("windows get a second to answer, and one that doesn't holds nothing up", async () => {
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], {}, LATER) : file(path), [{ path: "/map/", isSilent: true }, window("/", ["/assets/x-AAAAAAAA.js"])])
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  sw.entries.set("/assets/x-AAAAAAAA.js", new Response("x"))
  sw.entries.set("/assets/stale-AAAAAAAA.js", new Response("stale"))
  const navigation = sw.navigate("/map/")
  let isDone = false
  navigation.pending.then(() => isDone = true)
  await new Promise(resolve => setImmediate(resolve))
  expect(isDone).toBe(false)
  await vi.advanceTimersByTimeAsync(999)
  await new Promise(resolve => setImmediate(resolve))
  expect(isDone).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await navigation.done
  expect(sw.has("/assets/x-AAAAAAAA.js")).toBe(true)
  expect(sw.has("/assets/stale-AAAAAAAA.js")).toBe(false)
})

const tiles = (version: string) => ({ version, folders: [`/data/map/tiles/${version}/`] })

test("a week's tiles are kept while a page or a window runs them, beside a newer week's, whichever was fetched last", async () => {
  // The newer week's tiles are cached, then an old tab fetches a tile of its own week we didn't have
  const files = { A: "/assets/tiles-AAAAAAAA.json", B: "/assets/tiles-BBBBBBBB.json" }
  const sw = worker(async path =>
    path === "/map/"  ? page(["/assets/map-AAAAAAAA.js"], { tiles: files.B }, LATER) :
    path === files.A  ? Response.json(tiles("2026-10-10")) :
    path === files.B  ? Response.json(tiles("2026-10-17")) :
                        file(path),
    [window("/map/", ["/assets/map-AAAAAAAA.js"], { tiles: files.A }, tiles("2026-10-10"))]
  )
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"], { tiles: files.A }))
  sw.entries.set(files.A, Response.json(tiles("2026-10-10")))
  await sw.request("/data/map/tiles/2026-10-10/campus/16/1/1.pbf").done
  await sw.navigate("/map/").done
  await sw.request("/data/map/tiles/2026-10-17/campus/16/1/1.pbf").done
  await sw.request("/data/map/tiles/2026-10-10/campus/16/2/2.pbf").done
  await sw.message({ revalidate: "/map/" }).done
  expect(sw.paths().filter(path => path.includes("/tiles/"))).toEqual([
    "/data/map/tiles/2026-10-10/campus/16/1/1.pbf", "/data/map/tiles/2026-10-10/campus/16/2/2.pbf", "/data/map/tiles/2026-10-17/campus/16/1/1.pbf"
  ])

  // Once nothing runs the old week, a newer week again lets it go, along with the manifest that named it
  sw.windows.length = 0
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"], { tiles: "/assets/tiles-CCCCCCCC.json" }, "2026-10-20T08:00:00.000Z"))
  sw.entries.set("/map/?gen=prev", page(["/assets/map-AAAAAAAA.js"], { tiles: files.B }, LATER))
  sw.entries.set("/assets/tiles-CCCCCCCC.json", Response.json(tiles("2026-10-24")))
  await sw.activate().done
  expect(sw.paths().filter(path => path.includes("/tiles"))).toEqual(["/assets/tiles-BBBBBBBB.json", "/assets/tiles-CCCCCCCC.json", "/data/map/tiles/2026-10-17/campus/16/1/1.pbf"])
})

test("the dining files kept are those the retained indexes and the open dining tabs name, so a stale tab lets go of no newer tab's", async () => {
  const files = (names: string[]) => names.map(name => `/data/dining/${name}.json`)
  const index = (names: string[]) => Response.json({ halls: [], files: files(names) })
  const sw = worker(async path =>
    path === "/dining/"                 ? page(["/assets/dining-AAAAAAAA.js"], { menus: "/assets/menus-CCCCCCCC.json" }, LATER) :
    path === "/assets/menus-CCCCCCCC.json" ? index(["shared", "new1", "new2"]) :
                                          file(path),
    [window("/dining/", ["/assets/dining-AAAAAAAA.js"], { menus: "/assets/menus-AAAAAAAA.json" }, { files: files(["old1", "shared"]) })]
  )
  sw.entries.set("/dining/", page(["/assets/dining-AAAAAAAA.js"], { menus: "/assets/menus-BBBBBBBB.json" }))
  sw.entries.set("/assets/menus-BBBBBBBB.json", index(["mid1", "shared"]))
  for (const name of ["old1", "mid1", "shared", "new1", "new2", "gone"])
    sw.entries.set(`/data/dining/${name}.json`, new Response(name))
  await sw.navigate("/dining/").done
  expect(sw.paths().filter(path => path.startsWith("/data/dining/"))).toEqual(files(["mid1", "new1", "new2", "old1", "shared"]))
  sw.windows.length = 0
  await sw.activate().done
  expect(sw.paths().filter(path => path.startsWith("/data/dining/"))).toEqual(files(["mid1", "new1", "new2", "shared"]))
})

test("the style's folder is kept with the page that names it, so its sprite and fonts never mix versions", async () => {
  const style = (folder: string) => ({ url: `/data/map/${folder}/style.json`, folders: [`/data/map/${folder}/`] })
  const sw = worker(async path =>
    path === "/map/"                 ? page(["/assets/map-AAAAAAAA.js"], { style: "/assets/style-BBBBBBBB.json" }, LATER) :
    path === "/assets/style-BBBBBBBB.json" ? Response.json(style("BBBBBBBBBBBBBBBB")) :
                                      file(path)
  )
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"], { style: "/assets/style-AAAAAAAA.json" }))
  sw.entries.set("/assets/style-AAAAAAAA.json", Response.json(style("AAAAAAAAAAAAAAAA")))
  for (const folder of ["AAAAAAAAAAAAAAAA", "ZZZZZZZZZZZZZZZZ"])
    for (const file of ["style.json", "sprite.png", "fonts/Noto%20Sans%20Bold/0-255.pbf"])
      sw.entries.set(`/data/map/${folder}/${file}`, new Response(file))
  await sw.navigate("/map/").done
  const folders = new Set(sw.paths().flatMap(path => path.match(/^\/data\/map\/(\w+)\//)?.[1] ?? []))
  expect(folders).toEqual(new Set(["AAAAAAAAAAAAAAAA"]))
})

test("a page whose large file can't be kept, though its small HTML could be, is never kept, and is once there's room", async () => {
  // The quota has room for the page but not for the script it names
  const big = "/assets/dining/index-BBBBBBBB.js"
  let isRoom = false
  const sw = worker(async path => path === "/dining/" ? page([big], {}, LATER) : file(path), [{ path: "/dining/" }], { isFull: key => key === big && !isRoom })
  sw.entries.set("/dining/", page(["/assets/dining-AAAAAAAA.js"]))
  await sw.navigate("/dining/").done
  expect(await html(sw.entries.get("/dining/")!)).toContain("dining-AAAAAAAA")
  expect(sw.has(big)).toBe(false)
  expect(sw.messages).toEqual([])
  isRoom = true
  await sw.message({ revalidate: "/dining/" }).done
  expect(await html(sw.entries.get("/dining/")!)).toContain("index-BBBBBBBB")
  expect(sw.has(big)).toBe(true)
  expect(sw.messages.length).toBe(1)
})

test("a file answering as something else with a 200, as a sign-in page at a hashed URL, is served but never kept, nor a page naming it, until the origin answers rightly", async () => {
  // HTML at a JSON URL, then the right JSON there again
  const url = "/assets/menus-BBBBBBBB.json"
  const portal = () => new Response("<!doctype html><form>Sign in to UNH-Guest</form>", { headers: { "content-type": "text/html" } })
  let isPoisoned = true
  const sw = worker(async path => path === "/dining/" ? page(["/assets/dining-AAAAAAAA.js"], { menus: url }, LATER) : path === url && isPoisoned ? portal() : file(path), [{ path: "/dining/" }])
  sw.entries.set("/dining/", page(["/assets/dining-AAAAAAAA.js"], { menus: "/assets/menus-AAAAAAAA.json" }))
  sw.entries.set("/assets/dining-AAAAAAAA.js", file("/assets/dining-AAAAAAAA.js"))
  expect(await textOf(sw.request(url).response)).toContain("UNH-Guest")
  await sw.navigate("/dining/").done
  expect(sw.has(url)).toBe(false)
  expect(await html(sw.entries.get("/dining/")!)).toContain("menus-AAAAAAAA")
  isPoisoned = false
  await sw.message({ revalidate: "/dining/" }).done
  expect(await html(sw.entries.get("/dining/")!)).toContain("menus-BBBBBBBB")
  expect(await textOf(sw.request(url).response)).toBe(url)
})

test("a file asked for past the cache, as a page asks again for one that didn't fit, is fetched afresh and replaces the copy, or stands if the network can't answer", async () => {
  const url = "/assets/menus-BBBBBBBB.json"
  let network: Network = async path => file(path, "right")
  const sw = worker((path, init) => network(path, init))
  sw.entries.set(url, new Response("<form>wrong</form>", { headers: { "content-type": "text/html" } }))
  expect(await textOf(sw.request(url).response)).toBe("<form>wrong</form>")
  const { response, done } = sw.request(url, "cors", "reload")
  expect(await textOf(response)).toBe("right")
  await done
  expect(await textOf(sw.request(url).response)).toBe("right")
  // The network is asked past the browser's cache too
  expect(sw.fetched).toEqual([url])
  network = offline
  expect(await textOf(sw.request(url, "cors", "reload").response)).toBe("right")
})

test("a window and a staging share a download until its body ends, whichever asks first", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async windowFirst => {
    const asset = "/assets/map-BBBBBBBB.js"
    let body!: ReadableStreamDefaultController<Uint8Array>
    const sw = worker(async path => path === "/map/" ? page([asset], {}, LATER) :
      new Response(new ReadableStream({ start: controller => body = controller }), { headers: { "content-type": "text/javascript" } }))
    sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
    const first = windowFirst ? sw.request(asset) : sw.navigate("/map/")
    await vi.advanceTimersByTimeAsync(0)
    const second = windowFirst ? sw.navigate("/map/") : sw.request(asset)
    await vi.advanceTimersByTimeAsync(0)
    expect(sw.fetched.filter(path => path === asset)).toHaveLength(1)
    body.enqueue(new TextEncoder().encode("whole"))
    body.close()
    expect(await textOf((windowFirst ? first : second).response)).toBe("whole")
    await Promise.all([first.done, second.done])
    expect(await html(sw.entries.get("/map/")!)).toContain("map-BBBBBBBB")
    expect(await html(sw.entries.get(asset)!)).toBe("whole")
  }), { numRuns: 10 })
})

test("a failed staging leaves its shared download alive for a window still reading it", async () => {
  const asset = "/assets/map-BBBBBBBB.js"
  const missing = "/assets/missing-BBBBBBBB.js"
  let body!: ReadableStreamDefaultController<Uint8Array>
  let signal!: AbortSignal
  let fail!: () => void
  const sw = worker(async (path, init) => {
    if (path === "/map/")
      return page([asset, missing], {}, LATER)
    if (path === missing)
      return new Promise(resolve => fail = () => resolve(new Response("gone", { status: 404 })))
    signal = init!.signal!
    return new Response(new ReadableStream({ start: controller => {
      body = controller
      signal.addEventListener("abort", () => controller.error(signal.reason))
    } }), { headers: { "content-type": "text/javascript" } })
  })
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  const navigation = sw.navigate("/map/")
  await vi.advanceTimersByTimeAsync(0)
  const consumer = sw.request(asset)
  const response = await consumer.response
  fail()
  await vi.advanceTimersByTimeAsync(0)
  expect(signal.aborted).toBe(false)
  body.enqueue(new TextEncoder().encode("still available"))
  body.close()
  expect(await response.text()).toBe("still available")
  await Promise.all([navigation.done, consumer.done])
  expect(sw.fetched.filter(path => path === asset)).toHaveLength(1)
  expect(await html(sw.entries.get("/map/")!)).toContain("map-AAAAAAAA")
})

test("a shared download whose body stalls is evicted at its deadline, so a later request can retry", async () => {
  const asset = "/assets/map-BBBBBBBB.js"
  let stalled = true
  const sw = worker(async (path, init) => stalled ? new Response(new ReadableStream({ start: body => {
    init!.signal!.addEventListener("abort", () => body.error(init!.signal!.reason))
  } }), { headers: { "content-type": "text/javascript" } }) : file(path, "recovered"))
  const first = sw.request(asset)
  const reading = textOf(first.response)
  const rejected = expect(reading).rejects.toMatchObject({ name: "TimeoutError" })
  await vi.advanceTimersByTimeAsync(60_000)
  await rejected
  await first.done
  stalled = false
  const retry = sw.request(asset)
  expect(await textOf(retry.response)).toBe("recovered")
  await retry.done
  expect(sw.fetched).toEqual([asset, asset])
})

test("a reload bypasses a shared download and passes reload through to the network", async () => {
  const asset = "/assets/menus-BBBBBBBB.json"
  let finish!: () => void
  const modes: (RequestCache | undefined)[] = []
  const sw = worker(async (path, init) => {
    modes.push(init?.cache)
    return init?.cache === "reload" ? file(path, "fresh") : new Promise(resolve => finish = () => resolve(file(path, "old")))
  })
  const original = sw.request(asset)
  await vi.advanceTimersByTimeAsync(0)
  const retry = sw.request(asset, "cors", "reload")
  expect(await textOf(retry.response)).toBe("fresh")
  await retry.done
  finish()
  expect(await textOf(original.response)).toBe("old")
  await original.done
  expect(modes).toEqual([undefined, "reload"])
  expect(await html(sw.entries.get(asset)!)).toBe("fresh")
})

test("what a data file says it can't work without, as the map's style, is fetched with the page, which isn't kept without it", async () => {
  const styleUrl = "/data/map/BBBBBBBBBBBBBBBB/style.json"
  let isServed = false
  const sw = worker(async path =>
    path === "/map/"                       ? page(["/assets/map-AAAAAAAA.js"], { style: "/assets/style-BBBBBBBB.json" }, LATER) :
    path === "/assets/style-BBBBBBBB.json" ? Response.json({ url: styleUrl, required: [styleUrl], folders: ["/data/map/BBBBBBBBBBBBBBBB/"] }) :
    path === styleUrl && !isServed         ? new Response("gone", { status: 404 }) :
                                             file(path),
    [{ path: "/map/" }]
  )
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  await sw.navigate("/map/").done
  expect(await html(sw.entries.get("/map/")!)).not.toContain("style-BBBBBBBB")
  isServed = true
  await sw.message({ revalidate: "/map/" }).done
  expect(await html(sw.entries.get("/map/")!)).toContain("style-BBBBBBBB")
  expect(sw.has(styleUrl)).toBe(true)
  expect(sw.messages.length).toBe(1)
})

test("a worker killed in the middle of taking a page in leaves the copy we have, and the next takes it in whole", async () => {
  const held: (() => void)[] = []
  let isHolding = true
  const next = ["/assets/map-BBBBBBBB.js", "/assets/bruh-BBBBBBBB.js"]
  const sw = worker(path =>
    path === "/map/"  ? Promise.resolve(page(next, {}, LATER)) :
    isHolding         ? new Promise(resolve => held.push(() => resolve(file(path)))) :
                        Promise.resolve(file(path)),
    [{ path: "/map/" }]
  )
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  const navigation = sw.navigate("/map/")
  expect(await textOf(navigation.response)).toContain("map-AAAAAAAA")
  await vi.advanceTimersByTimeAsync(0)
  expect(held.length).toBe(2)
  // One file arrives, and the worker is killed before the other
  held[0]()
  await vi.advanceTimersByTimeAsync(0)
  sw.restart()
  expect(await html(sw.entries.get("/map/")!)).toContain("map-AAAAAAAA")
  expect(sw.messages).toEqual([])
  isHolding = false
  await sw.message({ revalidate: "/map/" }).done
  expect(await html(sw.entries.get("/map/")!)).toContain("map-BBBBBBBB")
  for (const path of next)
    expect(sw.has(path)).toBe(true)
  expect(sw.messages.length).toBe(1)
})

test("a file that stalls, before it answers, partway through its body, or kept behind an answer, is given up on at a deadline, keeping the copy we have, so other pages and files are still taken in", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("answer", "body", "kept"), async stall => {
    const stalled = "/assets/map-BBBBBBBB.js"
    // A body that never ends, unless the request is aborted, as a browser's does
    const endless = (signal?: AbortSignal | null) =>
      new Response(new ReadableStream({ start: body => signal?.addEventListener("abort", () => body.error(signal.reason)) }), { headers: { "content-type": "text/javascript" } })
    const sw = worker(async (path, init) =>
      path === "/map/"    ? page([stalled], {}, LATER) :
      path === "/dining/" ? page(["/assets/dining-BBBBBBBB.js"], {}, LATER) :
      path !== stalled    ? file(path) :
      stall === "answer"  ? never() :
                            endless(init?.signal)
    )
    sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
    sw.entries.set("/dining/", page(["/assets/dining-AAAAAAAA.js"]))
    // The map's page names the file, or a window asks for it, and it's kept behind the answer
    const first = stall === "kept" ? sw.request(stalled) : sw.navigate("/map/")
    await vi.advanceTimersByTimeAsync(0)
    const dining = sw.navigate("/dining/")
    const other = sw.request("/assets/other-AAAAAAAA.js")
    await Promise.all([dining.done, other.done, stall === "kept" ? undefined : first.done])
    expect(await html(sw.entries.get("/dining/")!)).toContain("dining-BBBBBBBB")
    expect(sw.has("/assets/other-AAAAAAAA.js")).toBe(true)
    expect(await html(sw.entries.get("/map/")!)).toContain("map-AAAAAAAA")
    expect(sw.has(stalled)).toBe(false)
  }))
})

test("a page that names an asset the network no longer serves is never kept, and its windows aren't told", async () => {
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], {}, LATER) : new Response("gone", { status: 404 }), [{ path: "/map/" }])
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  sw.entries.set("/assets/map-AAAAAAAA.js", new Response("a"))
  await sw.navigate("/map/").done
  expect(await html(sw.entries.get("/map/")!)).toContain("map-AAAAAAAA")
  expect(sw.messages).toEqual([])
  expect(sw.has("/assets/map-AAAAAAAA.js")).toBe(true)
})

//#endregion

//#region Quota

const opportunistic = fc.oneof(tile, styleFile.filter(path => !path.endsWith("style.json")), food)

test("a full quota never fails a fetch, and the ladder down is run once a storm: what nothing needs, then every tile, then every font and sprite", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(opportunistic, { maxLength: 8 }),
    fc.array(hashed, { minLength: 1, maxLength: 6 }),
    // How many puts the quota has room for, if any, once the ladder has been run
    fc.nat(3),
    async (cached, requested, room) => {
      let isFull = true
      let freed = 0
      const code = ["/assets/map-AAAAAAAA.js"]
      const style = "/data/map/SSSSSSSSSSSSSSSS/style.json"
      const sw = worker(async path => file(path, `new ${path}`), [], { isFull: () => isFull })
      sw.entries.set("/map/", page(code, { style: "/assets/style-AAAAAAAA.json" }))
      sw.entries.set("/assets/style-AAAAAAAA.json", Response.json({ url: style, folders: ["/data/map/SSSSSSSSSSSSSSSS/"] }))
      sw.entries.set(style, new Response("style"))
      sw.entries.set(code[0], new Response("code"))
      for (const path of cached)
        sw.entries.set(path, file(path))
      for (const path of requested) {
        const stored = sw.has(path) ? await sw.entries.get(path)!.clone().text() : undefined
        const { response, done } = sw.request(path)
        expect(await textOf(response)).toBe(stored ?? `new ${path}`)
        await done
        if (stored === undefined && freed++ === room)
          isFull = false
      }
      // The closure is never surrendered
      for (const path of ["/map/", code[0], "/assets/style-AAAAAAAA.json", style])
        expect(sw.has(path)).toBe(true)
      // Surrender is wholesale: of the tiles that were there and weren't asked for again since, either every one is
      // gone or none
      const untouched = cached.filter(path => path.startsWith("/data/map/tiles/") && !requested.includes(path))
      expect([0, untouched.length]).toContain(untouched.filter(path => sw.has(path)).length)
      // The ladder, which begins by asking the windows, is climbed once a storm, however many puts fail
      expect(sw.censuses()).toBeLessThanOrEqual(1)
    }
  ))
})

test("a quota storm climbs the ladder once, not once a put", async () => {
  const sw = worker(async path => file(path), [], { isFull: () => true })
  sw.entries.set("/map/", page(["/assets/map-AAAAAAAA.js"]))
  for (let i = 0; i < 10; i++)
    sw.entries.set(`/data/map/tiles/2026-10-17/campus/16/${i}/1.pbf`, new Response("tile"))
  const { response, done } = sw.request("/assets/x-AAAAAAAA.js")
  expect(await textOf(response)).toBe("/assets/x-AAAAAAAA.js")
  await done
  expect(sw.paths().filter(path => path.includes("/tiles/"))).toEqual([])
  expect(sw.censuses()).toBe(1)
  for (let i = 0; i < 20; i++)
    await sw.request(`/assets/y${i}-AAAAAAAA.js`).done
  expect(sw.censuses()).toBe(1)
})

test("puts failing together share each rung of the ladder rather than each climbing one, so what's needed of a page isn't let go for room only one rung would make", async () => {
  const tiles = "/data/map/tiles/2026-10-17/"
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], { gtfs: "/assets/gtfs-BBBBBBBB.json", model: "/assets/model-BBBBBBBB.json" }, LATER) : file(path), [], {
    // Full until what nothing needs is let go
    isFull: () => sw.has("/assets/stale-ZZZZZZZZ.js")
  })
  sw.entries.set("/", page(["/assets/home-AAAAAAAA.js"], { tiles: "/assets/tiles-AAAAAAAA.json" }))
  sw.entries.set("/assets/home-AAAAAAAA.js", new Response("home"))
  sw.entries.set("/assets/tiles-AAAAAAAA.json", Response.json({ folders: [tiles] }))
  sw.entries.set(`${tiles}campus/16/0/0.pbf`, new Response("tile"))
  sw.entries.set("/assets/stale-ZZZZZZZZ.js", new Response("stale"))
  await sw.navigate("/map/").done
  expect(sw.has("/map/")).toBe(true)
  expect(sw.has(`${tiles}campus/16/0/0.pbf`)).toBe(true)
  expect(sw.has("/assets/stale-ZZZZZZZZ.js")).toBe(false)
})

test("a storm the ladder gave up on doesn't keep a page out later, once letting go of what nothing needs makes room", async () => {
  let isFull = () => true
  const sw = worker(async path => path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], {}, LATER) : file(path), [], { isFull: () => isFull() })
  await sw.navigate("/map/").done
  expect(sw.has("/map/")).toBe(false)
  sw.entries.set("/assets/stale-ZZZZZZZZ.js", new Response("stale"))
  isFull = () => sw.has("/assets/stale-ZZZZZZZZ.js")
  await sw.navigate("/map/").done
  expect(sw.has("/map/")).toBe(true)
})

test("a full quota while a page is taken in never lets go of the style its data requires", async () => {
  const manifest = "/assets/style-BBBBBBBB.json"
  const style = "/data/map/BBBBBBBBBBBBBBBB/style.json"
  let wasFull = false
  const sw = worker(async path =>
    path === "/map/" ? page(["/assets/map-BBBBBBBB.js"], { style: manifest }, LATER) :
    path === manifest ? file(path, JSON.stringify({ url: style, required: [style], folders: ["/data/map/BBBBBBBBBBBBBBBB/"] })) :
    file(path), [], {
    // Full once, for the page itself, after all it needs is in
    isFull: key => key === "/map/" && !wasFull && (wasFull = true)
  })
  await sw.navigate("/map/").done
  expect(sw.has("/map/")).toBe(true)
  expect(sw.has(style)).toBe(true)
})

//#endregion
