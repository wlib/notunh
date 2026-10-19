// The service worker against a model of what the world is allowed to know, over generated sequences of what
// happens to it: releases published, windows opening pages and closing, going offline, the quota filling, the
// worker restarted, and windows freezing, as in the back-forward cache, so they can't say what they run

import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import { type Generation, buildOf } from "../../src/shell/manifest.mts"
import { type Window, page as html, worker } from "./sw.mts"

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

const closureOf = (release: Release, page: string) =>
  [...release[page].code, ...Object.values(release[page].data)]

const first = (): Release =>
  Object.fromEntries(PAGES.map(page => [page, { code: [`/assets/bruh-0.js`, `/assets${page}index-0.js`], data: { [`${page}data`]: `/assets${page}data-0.json` } }]))

/** The next release, with the shared chunk, and each page's code or data, changed as told */
const next = (releases: Release[], shared: boolean, changes: Record<string, "code" | "data" | "both" | "none">): Release => {
  const id = releases.length
  const last = releases[id - 1]
  return Object.fromEntries(PAGES.map(page => {
    const change = changes[page]
    const code = change === "code" || change === "both" ? `/assets${page}index-${id}.js` : last[page].code[1]
    const data = change === "data" || change === "both" ? `/assets${page}data-${id}.json` : Object.values(last[page].data)[0]
    return [page, { code: [shared ? `/assets/bruh-${id}.js` : last[page].code[0], code], data: { [`${page}data`]: data } }]
  }))
}

/** What the real world is allowed to know, kept simpler than the worker */
type Model = {
  published: number,
  /** By page, the releases whose copies the cache holds: the current, then the previous */
  stored:    Map<string, number[]>,
  windows:   Map<string, { page: string, release: number, isFrozen: boolean }>,
  offline:   boolean,
  isFull:    boolean
}

/** The worker in its world: every release so far, the one served, and the windows open */
const createHarness = () => {
  const releases: Release[] = [first()]
  const world = { published: 0, offline: false, isFull: false }
  const windows: (Window & { name: string })[] = []
  const network = async (path: string) => {
    if (world.offline)
      throw new TypeError("Load failed")
    const page = PAGES.find(page => page === path.split("?")[0])
    if (page) {
      const { code, data } = releases[world.published][page]
      return html(code, data, releaseAt(world.published))
    }
    return releases.some(release => PAGES.some(page => closureOf(release, page).includes(path)))
      ? new Response(path)
      : new Response("Not found", { status: 404 })
  }
  const sw = worker(network, windows, { isFull: () => world.isFull })
  /** Of each window's closure, what was in the cache the last time anyone looked, which must stay there */
  const seen = new Map<string, Set<string>>()
  const generationOf = (page: string, release: number): Generation =>
    ({ build: { release: releaseAt(release), code: releases[release][page].code, data: releases[release][page].data }, retain: { files: [], folders: [] } })
  return {
    sw,
    releases,
    world,
    windows,
    seen,
    generationOf,
    publish: (release: Release) => {
      releases.push(release)
      world.published = releases.length - 1
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

/** What the model expects kept for a page once the network's copy has been taken in, if it has */
const taken = (m: Model, h: Harness, page: string) => {
  const [cached, ...rest] = m.stored.get(page) ?? []
  // An older release, as from an edge not yet caught up or a rollback, is left alone
  if (m.offline || m.isFull || cached !== undefined && m.published <= cached)
    return
  // The same build from a newer release only renames the copy
  const isSameBuild = cached !== undefined && JSON.stringify(h.releases[cached][page]) === JSON.stringify(h.releases[m.published][page])
  m.stored.set(page, [m.published, ...isSameBuild ? rest : cached === undefined ? [] : [cached]])
}

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
 * still cover its release; and the cache agrees with the model about which releases each page is kept from
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

const navigate = command<{ window: string, page: string }>(({ window, page }) => `Navigate(${window}, ${page})`, always, async (m, h, { window, page }) => {
  h.close(window)
  m.windows.delete(window)
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
  await navigation.done
  taken(m, h, page)
  await verify(m, h)
})

const revalidate = command<string>(page => `Revalidate(${page})`, always, async (m, h, page) => {
  await h.sw.message({ revalidate: page })
  taken(m, h, page)
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

/** An edge serving an earlier release again, as before a deploy has reached it, or after a rollback */
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

/** A window asks for every file of its build, as its code does lazily, which must come, and stay, however it comes */
const request = command<{ window: string }>(({ window }) => `Request(${window})`, isOpen, async (m, h, { window }) => {
  const { page, release } = m.windows.get(window)!
  for (const asset of closureOf(h.releases[release], page)) {
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

const restart = command<void>(() => "Restart", always, async (m, h) => {
  h.sw.restart()
  await verify(m, h)
})

const activate = command<void>(() => "Activate", always, async (m, h) => {
  await h.sw.activate()
  await verify(m, h)
})

const setOffline = command<boolean>(offline => offline ? "GoOffline" : "GoOnline", always, async (m, h, offline) => {
  h.world.offline = m.offline = offline
})

const setFull = command<boolean>(isFull => isFull ? "FillQuota" : "FreeQuota", always, async (m, h, isFull) => {
  h.world.isFull = m.isFull = isFull
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
  fc.boolean().map(setOffline),
  fc.boolean().map(setFull)
]

test("every copy of a page in the cache is whole, no open window loses a file of its build, and what each page is kept from is as modelled, whatever happens", async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { size: "+1" }), async sequence => {
    const setup = () => ({
      model: { published: 0, stored: new Map(), windows: new Map(), offline: false, isFull: false } as Model,
      real: createHarness()
    })
    await fc.asyncModelRun(setup, sequence)
  }), { numRuns: 60 })
})

test("once the quota has room and the network is back, nothing is kept but the retained generations' closures", async () => {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { size: "+1" }), async sequence => {
    const setup = () => ({
      model: { published: 0, stored: new Map(), windows: new Map(), offline: false, isFull: false } as Model,
      real: createHarness()
    })
    const { model, real } = setup()
    await fc.asyncModelRun(() => ({ model, real }), sequence)
    // Back to normal, and a newer release of every page taken in, which prunes
    real.world.offline = model.offline = false
    real.world.isFull = model.isFull = false
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
