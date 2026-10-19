// The service worker against a model of what the world is allowed to know, over generated sequences of what
// happens to it: releases published, the map's with a style that requires its style.json and keeps its folder, and
// tiles kept by folder, windows opening pages, asking for their files, and closing, going offline, the quota
// filling, for every file, only the large ones, or until the worker next lets go of something, for every file or
// only pages, the origin answering a sign-in page in place of a data file, the network holding a page's files while
// anything else happens, the worker restarted, killed in the middle of taking a page in, upgraded from the first
// worker's cache, and windows freezing, as in the back-forward cache, so they can't say what they run

import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import { type Generation, buildOf, mergedRetain, retainOf } from "../../src/shell/manifest.mts"
import { type Window, CACHE, OLD_CACHE, file, page as html, settled, worker } from "./sw.mts"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
})

const PAGES = ["/", "/map/", "/dining/"]
const WINDOWS = ["w1", "w2", "w3"]

/** One deploy: for each page, the code and data it names, all hashed by the release that last changed them */
type Release = Record<string, { code: string[], data: Record<string, string> }>

const releaseAt = (id: number) => `2026-10-${String(id + 1).padStart(2, "0")}T08:00:00.000Z`
const idOf = (release: string) => +release.slice(8, 10) - 1

/** The data files each page names: the map's style and tiles too, which ask the cache for more by the Retain shape */
const DATA: Record<string, string[]> = { "/": ["data"], "/map/": ["data", "style", "tiles"], "/dining/": ["data"] }

const dataOf = (page: string, id: number) =>
  Object.fromEntries(DATA[page].map(name => [name, `/assets${page}${name}-${id}.json`]))

/** What a data file holds, by its URL: the style requires its style.json and keeps its folder, the tiles theirs */
const bodyOf = (path: string) => {
  const [, name, id] = path.match(/^\/assets\/map\/(style|tiles)-(\d+)\.json$/) ?? []
  return name === "style" ? { required: [`/data/map/style-${id}/style.json`], folders: [`/data/map/style-${id}/`] } :
         name === "tiles" ? { folders: [`/data/map/tiles/${id}/`] } :
                            {}
}

const retainIn = (release: Release, page: string) =>
  mergedRetain(Object.values(release[page].data).map(path => retainOf(bodyOf(path))))

/** Everything a page from a release needs to open whole: its code, its data, and what its data requires */
const closureOf = (release: Release, page: string) =>
  [...release[page].code, ...Object.values(release[page].data), ...retainIn(release, page).required]

/** A file of each folder a page's data keeps, as maplibre asks for them: a tile, and a font of the style */
const foldersOf = (release: Release, page: string) =>
  retainIn(release, page).folders.map(folder => `${folder}${folder.includes("tiles") ? "14/0/0.pbf" : "fonts/0-255.pbf"}`)

const first = (): Release =>
  Object.fromEntries(PAGES.map(page => [page, { code: [`/assets/bruh-0.js`, `/assets${page}index-0.js`], data: dataOf(page, 0) }]))

/** The next release, with the shared chunk, and each page's code or data, changed as told */
const next = (releases: Release[], shared: boolean, changes: Record<string, "code" | "data" | "both" | "none">): Release => {
  const id = releases.length
  const last = releases[id - 1]
  return Object.fromEntries(PAGES.map(page => {
    const change = changes[page]
    const code = change === "code" || change === "both" ? `/assets${page}index-${id}.js` : last[page].code[1]
    const data = change === "data" || change === "both" ? dataOf(page, id) : last[page].data
    return [page, { code: [shared ? `/assets/bruh-${id}.js` : last[page].code[0], code], data }]
  }))
}

/**
 * How full the origin's quota is: for every put, or only the data files', the large ones, while pages still fit; or
 * until the worker next lets go of something, for every put or only pages', when what it lets go of makes room
 */
type Quota = "none" | "all" | "data" | "until pruned" | "pages until pruned"

/** What a page's revalidation saw of the world as it began, which is what it goes by once its files arrive */
type Seen = { published: number, offline: boolean, corrupt: boolean }

/** What the real world is allowed to know, kept simpler than the worker */
type Model = {
  published: number,
  /** By page, the releases whose copies the cache holds: the current, then the previous */
  stored:    Map<string, number[]>,
  windows:   Map<string, { page: string, release: number, isFrozen: boolean }>,
  offline:   boolean,
  quota:     Quota,
  /** Whether the origin answers a sign-in page in place of every data file */
  corrupt:   boolean,
  /** While the network is holding every file asked for, the revalidations waiting on it, in order */
  holding?:  { page: string, seen: Seen }[]
}

/** The worker in its world: every release so far, the one served, and the windows open */
const createHarness = () => {
  const releases: Release[] = [first()]
  const world = { published: 0, offline: false, quota: "none" as Quota, corrupt: false, holding: undefined as (() => void)[] | undefined }
  const windows: (Window & { name: string })[] = []
  const network = async (path: string) => {
    if (world.offline)
      throw new TypeError("Load failed")
    const page = PAGES.find(page => page === path.split("?")[0])
    if (page) {
      const { code, data } = releases[world.published][page]
      return html(code, data, releaseAt(world.published))
    }
    // As a captive portal does, for every data file, so what's corrupt doesn't change while a hold delays who asks
    const isCorrupt = world.corrupt && path.endsWith(".json")
    const response =
      isCorrupt ? new Response("<!doctype html><form>Sign in to UNH-Guest</form>", { headers: { "content-type": "text/html" } }) :
      releases.some(release => PAGES.some(page => [...closureOf(release, page), ...foldersOf(release, page)].includes(path))) ? file(path, JSON.stringify(bodyOf(path))) :
      new Response("Not found", { status: 404 })
    if (!world.holding)
      return response
    // The answer is decided now, as the network has it, and delivered when the hold is released, if ever
    return new Promise<Response>(resolve => world.holding!.push(() => resolve(response)))
  }
  // How many times the worker had listed the cache, to let go of anything, when the quota last changed
  let listed = 0
  const isFull = (key: string) =>
    world.quota === "all" ||
    world.quota === "data" && key.endsWith(".json") ||
    world.quota === "until pruned" && sw.listings() === listed ||
    world.quota === "pages until pruned" && /\/(\?gen=prev)?$/.test(key) && sw.listings() === listed
  const sw = worker(network, windows, { isFull })
  /** Of each window's closure, what was in the cache the last time anyone looked, which must stay there */
  const seen = new Map<string, Set<string>>()
  /** The revalidations under way while the network holds their files, each pending until it's through */
  const outstanding: Promise<unknown>[] = []
  const generationOf = (page: string, release: number): Generation =>
    ({ build: { release: releaseAt(release), code: releases[release][page].code, data: releases[release][page].data }, retain: retainIn(releases[release], page) })
  return {
    sw,
    releases,
    world,
    windows,
    seen,
    outstanding,
    generationOf,
    publish: (release: Release) => {
      releases.push(release)
      world.published = releases.length - 1
    },
    setQuota: (quota: Quota) => {
      world.quota = quota
      listed = sw.listings()
    },
    open: (name: string, page: string, release: number) => {
      windows.push({ name, path: page, generation: generationOf(page, release), isSilent: false })
    },
    close: (name: string) => {
      const i = windows.findIndex(window => window.name === name)
      if (i >= 0)
        windows.splice(i, 1)
      seen.delete(name)
    },
    freeze: (name: string, isFrozen: boolean) => {
      const window = windows.find(window => window.name === name)
      if (window)
        window.isSilent = isFrozen
    }
  }
}
type Harness = ReturnType<typeof createHarness>

/**
 * What a revalidation, by what it saw as it began, makes of the page's copy: nothing, for an older release, as from
 * an edge not yet caught up or a platform rollback, or offline; a newer release of the same build, which only renames it; or
 * a newer build, which it takes in, fetching what's missing of it
 */
const changeOf = (m: Model, h: Harness, page: string, seen: Seen) => {
  const cached = m.stored.get(page)?.[0]
  if (seen.offline || cached !== undefined && seen.published <= cached)
    return "none"
  const isSameBuild = cached !== undefined && JSON.stringify(h.releases[cached][page]) === JSON.stringify(h.releases[seen.published][page])
  return isSameBuild ? "release" : "build"
}

/**
 * What the model expects kept for a page once the network's copy has been taken in, if it has, going by what the
 * revalidation saw as it began, and the quota as its files are kept
 */
const taken = (m: Model, h: Harness, page: string, seen: Seen) => {
  const [cached, ...rest] = m.stored.get(page) ?? []
  const change = changeOf(m, h, page, seen)
  if (change === "none")
    return
  // The same build from a newer release only renames the copy, which a full quota refuses
  if (change === "release") {
    if (m.quota !== "all")
      m.stored.set(page, [seen.published, ...rest])
    return
  }
  // A newer build is kept only with every file it needs kept, and whole: not with the quota full for any of them,
  // nor, for a data file it had to fetch, with the quota full for data or the origin answering a sign-in page for it.
  // A data file it had to fetch and couldn't keep isn't in the cache now either, which is how the model tells. A
  // quota full until the worker lets go of something is no matter, as it lets go of what nothing needs first
  const missing = closureOf(h.releases[seen.published], page).some(path => path.endsWith(".json") && !h.sw.has(path))
  if (m.quota === "all" || missing && (m.quota === "data" || seen.corrupt))
    return
  m.stored.set(page, [seen.published, ...cached === undefined ? [] : [cached]])
}

/** What a revalidation beginning now sees */
const seenNow = (m: Model): Seen => ({ published: m.published, offline: m.offline, corrupt: m.corrupt })

/** The releases a page's copies in the cache are from, current then previous, as the worker keeps them */
const storedIn = async (h: Harness, page: string) => {
  const ids: number[] = []
  for (const key of [page, `${page}?gen=prev`]) {
    const copy = h.sw.entries.get(key)
    if (copy)
      ids.push(idOf(buildOf(await copy.clone().text()).release))
  }
  return ids
}

/**
 * What must hold whatever has happened: every copy of a page in the cache is whole, so it opens offline; nothing an
 * open window's build needs that was there has gone, while the window can answer for itself or its page's copies
 * still cover its release, which is the policy, a frozen window older than its page's previous generation being
 * brought up to date when it resumes rather than kept whole; and the cache agrees with the model about which
 * releases each page is kept from
 */
const verify = async (m: Model, h: Harness) => {
  for (const page of PAGES) {
    const ids = await storedIn(h, page)
    expect(ids).toEqual(m.stored.get(page) ?? [])
    for (const id of ids)
      for (const asset of closureOf(h.releases[id], page))
        expect(h.sw.has(asset), `${page} from ${id} names ${asset}`).toBe(true)
  }
  for (const [name, { page, release, isFrozen }] of m.windows) {
    const isCovered = !isFrozen || (m.stored.get(page) ?? []).includes(release)
    const assets = closureOf(h.releases[release], page)
    const had = h.seen.get(name) ?? new Set()
    if (isCovered)
      for (const asset of assets)
        if (had.has(asset))
          expect(h.sw.has(asset), `window ${name} on ${page} from ${release} had ${asset}`).toBe(true)
    h.seen.set(name, new Set(assets.filter(asset => h.sw.has(asset))))
  }
}

type Command = fc.AsyncCommand<Model, Harness>

/** A kind of command, by what it's called, when it applies, and what it does to the world and the model */
const command = <A,>(name: (a: A) => string, check: (m: Model, a: A) => boolean, run: (m: Model, h: Harness, a: A) => Promise<void>) =>
  (a: A): Command => ({ check: m => check(m, a), run: (m, h) => run(m, h, a), toString: () => name(a) })

const always = () => true
const isOpen = (m: Model, { window }: { window: string }) => m.windows.has(window)
const isFree = (m: Model) => !m.holding

/**
 * A revalidation's outcome, modelled now, or once the hold is released if it waits on the network, which it does
 * while the network holds a file it has to fetch, or another revalidation ahead of it in the worker's turn
 */
const revalidated = async (m: Model, h: Harness, page: string, seen: Seen, { pending, done }: { pending: Promise<unknown>, done: Promise<unknown> }) => {
  const fetches = changeOf(m, h, page, seen) === "build" && closureOf(h.releases[seen.published], page).some(path => !h.sw.has(path))
  if (m.holding && (m.holding.length || fetches)) {
    m.holding.push({ page, seen })
    h.outstanding.push(pending)
    return
  }
  await done
  taken(m, h, page, seen)
}

const navigate = command<{ window: string, page: string }>(({ window, page }) => `Navigate(${window}, ${page})`, always, async (m, h, { window, page }) => {
  h.close(window)
  m.windows.delete(window)
  const seen = seenNow(m)
  const navigation = h.sw.navigate(page)
  const cached = m.stored.get(page)?.[0]
  const served = await navigation.response.then(async response => response.ok ? idOf(buildOf(await response.text()).release) : undefined, () => undefined)
  // Served from the cache if there was one, else the network's, else the home page, else nothing
  const runs = cached !== undefined ? { page, release: cached } :
               !m.offline          ? { page, release: m.published } :
               m.stored.has("/")   ? { page: "/", release: m.stored.get("/")![0] } :
                                     undefined
  expect(served).toBe(runs?.release)
  if (runs) {
    h.open(window, runs.page, runs.release)
    m.windows.set(window, { ...runs, isFrozen: false })
  }
  await revalidated(m, h, page, seen, navigation)
  await verify(m, h)
})

const revalidate = command<string>(page => `Revalidate(${page})`, always, async (m, h, page) => {
  const seen = seenNow(m)
  await revalidated(m, h, page, seen, h.sw.message({ revalidate: page }))
  await verify(m, h)
})

const publish = command<{ shared: boolean, changes: Record<string, "code" | "data" | "both" | "none"> }>(
  ({ shared, changes }) => `Publish(${shared ? "shared, " : ""}${Object.entries(changes).map(([page, change]) => `${page} ${change}`).join(", ")})`,
  always,
  async (m, h, { shared, changes }) => {
    h.publish(next(h.releases, shared, changes))
    m.published = h.world.published
    await verify(m, h)
  }
)

/** An edge serving an earlier release again, as before a deploy has reached it, or after a platform rollback */
const rollback = command<number>(back => `Rollback(${back})`, (m, back) => m.published >= back, async (m, h, back) => {
  h.world.published = m.published = m.published - back
  await verify(m, h)
})

const close = command<{ window: string }>(({ window }) => `Close(${window})`, isOpen, async (m, h, { window }) => {
  h.close(window)
  m.windows.delete(window)
  await verify(m, h)
})

const freeze = command<{ window: string, isFrozen: boolean }>(({ window, isFrozen }) => `${isFrozen ? "Freeze" : "Thaw"}(${window})`, isOpen, async (m, h, { window, isFrozen }) => {
  h.freeze(window, isFrozen)
  m.windows.get(window)!.isFrozen = isFrozen
  await verify(m, h)
})

/**
 * A window asks for every file of its build, as its code does lazily, which must come, and stay, however it comes,
 * and a file of each folder its data keeps, which must come, though it may be let go for room
 */
const request = command<{ window: string }>(({ window }) => `Request(${window})`, (m, a) => isOpen(m, a) && isFree(m), async (m, h, { window }) => {
  const { page, release } = m.windows.get(window)!
  for (const asset of [...closureOf(h.releases[release], page), ...foldersOf(h.releases[release], page)]) {
    const wasCached = h.sw.has(asset)
    const { response, done } = h.sw.request(asset)
    if (wasCached || !m.offline)
      expect((await response).ok).toBe(true)
    else
      await expect(response).rejects.toThrow()
    await done
  }
  await verify(m, h)
})

/** The browser kills the worker in the middle of whatever it was doing: what the network was holding for it never arrives */
const restart = command<void>(() => "Restart", always, async (m, h) => {
  h.sw.restart()
  if (m.holding) {
    h.world.holding = []
    h.outstanding.length = 0
    m.holding = []
  }
  await verify(m, h)
})

const activate = command<void>(() => "Activate", isFree, async (m, h) => {
  await h.sw.activate().done
  await verify(m, h)
})

/**
 * The first worker's cache, as a client of it left it, met by this worker activating: pages naming only their code,
 * as theirs loaded the data and maplibre's worker by URL, which the origin no longer has. Nothing of it is ever
 * served, as what its pages need can't be told
 */
const upgrade = command<void>(() => "Upgrade", isFree, async (m, h) => {
  h.sw.stores.set(OLD_CACHE, new Map(PAGES.flatMap(page => [
    [page, new Response(`<!doctype html><html><head><script type="module" src="/assets${page}v1.js"></script></head></html>`, { headers: { "content-type": "text/html" } })],
    [`/assets${page}v1.js`, file(`/assets${page}v1.js`)],
    [`/assets${page}gtfs-v1.json`, file(`/assets${page}gtfs-v1.json`)],
    [`/assets${page}maplibre-gl-worker-v1.js`, file(`/assets${page}maplibre-gl-worker-v1.js`)]
  ])))
  await h.sw.activate().done
  expect([...h.sw.stores.keys()]).toEqual([CACHE])
  await verify(m, h)
})

// What the network answers changes only while it holds nothing, as a revalidation waiting its turn behind a held
// one asks for its files at its turn, and the model doesn't follow the worker that closely
const setOffline = command<boolean>(offline => offline ? "GoOffline" : "GoOnline", isFree, async (m, h, offline) => {
  h.world.offline = m.offline = offline
})

const setCorrupt = command<boolean>(corrupt => corrupt ? "Corrupt" : "Restore", isFree, async (m, h, corrupt) => {
  h.world.corrupt = m.corrupt = corrupt
})

// The quota, though, is met when a file is kept, which under a hold is when it's released, for every revalidation waiting
const setQuota = command<Quota>(quota => `Quota(${quota})`, always, async (m, h, quota) => {
  h.setQuota(m.quota = quota)
})

/** The network holds every file asked for from now until released, when they all arrive at once */
const hold = command<void>(() => "Hold", isFree, async (m, h) => {
  h.world.holding = []
  m.holding = []
})

const release = command<void>(() => "Release", m => Boolean(m.holding), async (m, h) => {
  const held = h.world.holding!
  const waiting = m.holding!
  h.world.holding = undefined
  m.holding = undefined
  for (const deliver of held)
    deliver()
  await settled(Promise.all(h.outstanding.splice(0)))
  for (const { page, seen } of waiting)
    taken(m, h, page, seen)
  await verify(m, h)
})

const window = fc.constantFrom(...WINDOWS)
const page = fc.constantFrom(...PAGES)
const change = fc.constantFrom("code", "data", "both", "none" as const)
const commands = [
  fc.record({ window, page }).map(navigate),
  page.map(revalidate),
  fc.record({ shared: fc.boolean(), changes: fc.tuple(change, change, change).map(changes => Object.fromEntries(PAGES.map((page, i) => [page, changes[i]]))) }).map(publish),
  fc.integer({ min: 1, max: 3 }).map(rollback),
  fc.record({ window }).map(close),
  fc.record({ window, isFrozen: fc.boolean() }).map(freeze),
  fc.record({ window }).map(request),
  fc.constant(restart()),
  fc.constant(activate()),
  fc.constant(upgrade()),
  fc.boolean().map(setOffline),
  fc.constantFrom<Quota>("none", "all", "data", "until pruned", "pages until pruned").map(setQuota),
  fc.boolean().map(setCorrupt),
  fc.constant(hold()),
  fc.constant(release())
]

const setup = () => ({
  model: { published: 0, stored: new Map(), windows: new Map(), offline: false, quota: "none", corrupt: false } as Model,
  real: createHarness()
})

test("every copy of a page in the cache is whole, no open window loses a file of its build, and what each page is kept from is as modelled, whatever happens", async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { size: "+1" }), async sequence => {
    await fc.asyncModelRun(setup, sequence)
  }), { numRuns: 80 })
})

test("once the quota has room, the network is back and whole, and nothing is held, nothing is kept but the retained generations' closures", async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { size: "+1" }), async sequence => {
    const { model, real } = setup()
    await fc.asyncModelRun(() => ({ model, real }), sequence)
    // Back to normal, and a newer release of every page taken in, which prunes
    if (model.holding)
      await release().run(model, real)
    real.world.offline = model.offline = false
    real.setQuota(model.quota = "none")
    real.world.corrupt = model.corrupt = false
    real.publish(next(real.releases, true, Object.fromEntries(PAGES.map(page => [page, "both"]))))
    model.published = real.world.published
    for (const page of PAGES) {
      await real.sw.navigate(page).done
      model.stored.set(page, [model.published, ...model.stored.get(page)?.slice(0, 1) ?? []])
    }
    await verify(model, real)
    const needed = new Set([
      ...[...model.stored].flatMap(([page, ids]) => ids.flatMap(id => closureOf(real.releases[id], page))),
      ...[...model.windows.values()].filter(({ isFrozen }) => !isFrozen).flatMap(({ page, release }) => closureOf(real.releases[release], page))
    ])
    // A window served while the quota was full may still lack files, which come as it asks for them
    for (const path of real.sw.paths().filter(path => path.startsWith("/assets/")))
      expect(needed.has(path), path).toBe(true)
  }), { numRuns: 40 })
})
