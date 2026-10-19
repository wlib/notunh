import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { buildOf, isRetained, retainOf } from "../../src/shell/manifest.mts"
import { Model, emptyModel } from "../../src/map/model.mts"
import { RELEASE, fakePage, headOf, leavePage } from "./page.mts"

afterEach(leavePage)

const NOON = Date.UTC(2026, 9, 7, 16)

const hash = fc.stringMatching(/^[A-Za-z0-9_-]{8}$/)
const names = fc.uniqueArray(fc.constantFrom("gtfs", "model", "walk", "gazetteer", "tiles", "menus", "usual"), { maxLength: 7 })
const dataOf = (names: string[], hashes: string[]) =>
  Object.fromEntries(names.map((name, i) => [name, `/assets/${name}-${hashes[i % hashes.length]}.json`]))
const code = fc.uniqueArray(hash.map(hash => `/assets/index-${hash}.js`), { minLength: 1, maxLength: 4 })

/** A page loaded with a head naming some data, and the build module watching it, with what each URL answers */
const load = async (data: Record<string, string>, code?: string[]) => {
  fakePage({ at: NOON, data, code })
  const answers = new Map<string, () => Promise<unknown>>()
  const fetches: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    fetches.push(url)
    const answer = answers.get(url)
    if (!answer)
      throw new TypeError("Load failed")
    return Response.json(await answer())
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
  return { answers, fetches, ...await import("../../src/shell/build.mts") }
}

test("a page's head says which release it's from, which code it runs, and which data it loads, by name", () =>
  fc.assert(fc.property(names, fc.array(hash, { minLength: 1 }), code, (names, hashes, scripts) => {
    const data = dataOf(names, hashes)
    expect(buildOf(headOf(data, scripts))).toEqual({ release: RELEASE, code: scripts, data })
  }))
)

test("a page's build is read from our own code in its head, whatever else the host, an extension, or its body adds", () => {
  const data = { gtfs: "/assets/gtfs-AAAAAAAA.json" }
  const served =
    `<!doctype html><html lang="en-US"><head><meta charset="UTF-8"><meta name="release" content="${RELEASE}"><link rel="manifest" href="/manifest.webmanifest">` +
    `<link rel="preload" as="fetch" crossorigin="anonymous" href="/assets/gtfs-AAAAAAAA.json" data-name="gtfs">` +
    `<script type="module" crossorigin src="/assets/map/index-AAAAAAAA.js"></script>` +
    `<link rel="modulepreload" crossorigin href="/assets/bruh-AAAAAAAA.js"><link rel="stylesheet" crossorigin href="/assets/index-AAAAAAAA.css">` +
    `<link rel="prefetch" href="/assets/maplibre-gl-worker-AAAAAAAA.js">` +
    `<script src="chrome-extension://abcdef/content.js"></script><script nonce="x"></script></head>` +
    `<body><div id="app"></div><script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script></body></html>`
  const head =
    `<head><meta charset="UTF-8"><meta name="release" content="${RELEASE}"><link rel="manifest" href="/manifest.webmanifest">` +
    `<link rel="preload" as="fetch" crossorigin="anonymous" href="/assets/gtfs-AAAAAAAA.json" data-name="gtfs">` +
    `<script type="module" crossorigin="" src="/assets/map/index-AAAAAAAA.js"></script>` +
    `<link rel="modulepreload" crossorigin="" href="/assets/bruh-AAAAAAAA.js"><link rel="stylesheet" crossorigin="" href="/assets/index-AAAAAAAA.css">` +
    `<link rel="prefetch" href="/assets/maplibre-gl-worker-AAAAAAAA.js"></head>`
  expect(buildOf(served)).toEqual(buildOf(head))
  expect(buildOf(served)).toEqual({
    release: RELEASE,
    code: ["/manifest.webmanifest", "/assets/map/index-AAAAAAAA.js", "/assets/bruh-AAAAAAAA.js", "/assets/index-AAAAAAAA.css", "/assets/maplibre-gl-worker-AAAAAAAA.js"],
    data
  })
  expect(buildOf("<form>Sign in to UNH-Guest</form>").release).toBe("")
})

test("a data file keeps what it names, by its shape, and anything else keeps nothing", () => {
  fc.assert(fc.property(fc.anything(), value => {
    const { files, folders } = retainOf(value)
    const { files: named = [], folders: namedFolders = [] } = Object(value)
    expect(files).toEqual(Array.isArray(named) ? named.filter(item => typeof item === "string") : [])
    expect(folders).toEqual(Array.isArray(namedFolders) ? namedFolders.filter(item => typeof item === "string") : [])
  }))
  const keep = isRetained([
    { build: { release: RELEASE, code: ["/assets/a.js"], data: { tiles: "/assets/tiles.json" } }, retain: { files: ["/data/dining/x.json"], folders: ["/data/map/tiles/2026-10-17/"] } }
  ])
  expect(["/assets/a.js", "/assets/tiles.json", "/data/dining/x.json", "/data/map/tiles/2026-10-17/campus/16/1/1.pbf"].map(keep)).toEqual([true, true, true, true])
  expect(["/assets/b.js", "/data/dining/y.json", "/data/map/tiles/2026-10-10/campus/16/1/1.pbf", "/data/map/tiles/2026-10-17"].map(keep)).toEqual([false, false, false, false])
})

test("a newer copy of the same code loads its newer data, and one of newer code waits for a reload", () =>
  fc.assert(fc.asyncProperty(names, fc.array(hash, { minLength: 1 }), fc.array(hash, { minLength: 1 }), code, code, async (names, before, after, scripts, nextScripts) => {
    const page = await load(dataOf(names, before), scripts)
    for (const url of [...Object.values(dataOf(names, before)), ...Object.values(dataOf(names, after))])
      page.answers.set(url, async () => url)
    const loaded = Object.fromEntries(await Promise.all(names.map(async name => [name, await page.latest<string>(name)])))
    page.receive(`<!doctype html>${headOf(dataOf(names, after), nextScripts)}<body></body>`)
    await vi.advanceTimersByTimeAsync(0)
    const isSameCode = scripts.join() === nextScripts.join()
    expect(page.isNewBuild.peek()).toBe(!isSameCode)
    for (const name of names)
      expect(loaded[name].peek()).toBe(dataOf(names, isSameCode ? after : before)[name])
  }))
)

test("data is loaded again when a newer build names newer, swapped in once loaded, and kept if it can't load, which is tried again, and at once when named again", async () => {
  const page = await load({ gtfs: "/assets/gtfs-AAAAAAAA.json" })
  page.answers.set("/assets/gtfs-AAAAAAAA.json", async () => "A")
  const gtfs = await page.latest<string>("gtfs")
  expect(gtfs.peek()).toBe("A")

  let answer: (value: string) => void = () => {}
  page.answers.set("/assets/gtfs-BBBBBBBB.json", () => new Promise(resolve => answer = resolve))
  page.receive(headOf({ gtfs: "/assets/gtfs-BBBBBBBB.json" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(gtfs.peek()).toBe("A")
  answer("B")
  await vi.advanceTimersByTimeAsync(0)
  expect(gtfs.peek()).toBe("B")

  // C can't load: B stays, and C is tried again after a while, then longer, until it loads
  page.receive(headOf({ gtfs: "/assets/gtfs-CCCCCCCC.json" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(gtfs.peek()).toBe("B")
  const tries = () => page.fetches.filter(url => url.includes("CCCCCCCC")).length
  expect(tries()).toBe(1)
  await vi.advanceTimersByTimeAsync(4_999)
  expect(tries()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(tries()).toBe(2)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(tries()).toBe(3)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(tries()).toBe(4)
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(tries()).toBe(5 + i)
  }
  // The same build named again, as by another navigation, is a fresh chance right away
  page.receive(headOf({ gtfs: "/assets/gtfs-CCCCCCCC.json" }))
  await vi.advanceTimersByTimeAsync(0)
  expect(tries()).toBe(8)
  page.answers.set("/assets/gtfs-CCCCCCCC.json", async () => "C")
  await vi.advanceTimersByTimeAsync(5_000)
  expect(gtfs.peek()).toBe("C")
  expect(tries()).toBe(9)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(tries()).toBe(9)
})

test("of builds coming faster than their data loads, only the newest's is swapped in", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(hash, { minLength: 2, maxLength: 6 }), fc.func(fc.integer()), async (hashes, order) => {
    const page = await load({ gtfs: `/assets/gtfs-${hashes[0]}.json` })
    const pending = new Map<string, () => void>()
    for (const [i, hash] of hashes.entries())
      page.answers.set(`/assets/gtfs-${hash}.json`, () => i ? new Promise(resolve => pending.set(hash, () => resolve(hash))) : Promise.resolve(hash))
    const gtfs = await page.latest<string>("gtfs")
    for (const hash of hashes.slice(1)) {
      page.receive(headOf({ gtfs: `/assets/gtfs-${hash}.json` }))
      await vi.advanceTimersByTimeAsync(0)
    }
    // Each load answers in some order, though those named while an earlier one loaded wait for it
    for (const hash of hashes.slice(1).sort((a, b) => order(a) - order(b))) {
      pending.get(hash)?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    pending.get(hashes.at(-1)!)?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(gtfs.peek()).toBe(hashes.at(-1))
  }))
})

test("the data files of a newer build are swapped in together, once all of them have loaded, so what depends on several never sees a mix", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.constantFrom("gtfs", "model", "walk"), { minLength: 2, maxLength: 3 }), fc.func(fc.integer()), async (names, order) => {
    const page = await load(dataOf(names, ["AAAAAAAA"]))
    const pending = new Map<string, () => void>()
    for (const name of names) {
      page.answers.set(`/assets/${name}-AAAAAAAA.json`, async () => `${name} A`)
      page.answers.set(`/assets/${name}-BBBBBBBB.json`, () => new Promise(resolve => pending.set(name, () => resolve(`${name} B`))))
    }
    const values = Object.fromEntries(await Promise.all(names.map(async name => [name, await page.latest<string>(name)])))
    const { r } = await import("bruh/reactive")
    const seen: string[] = []
    const together = r(() => names.map(name => values[name].value.split(" ")[1]).join(""))
    page.receive(headOf(dataOf(names, ["BBBBBBBB"])))
    for (const name of [...names].sort((a, b) => order(a) - order(b))) {
      seen.push(together.value)
      pending.get(name)!()
      await vi.advanceTimersByTimeAsync(0)
    }
    seen.push(together.value)
    expect(seen).toEqual([...names.map(() => "A".repeat(names.length)), "B".repeat(names.length)])
  }))
})

test("a build with a member that fails keeps every old value and loads the rest once it comes through", async () => {
  const page = await load(dataOf(["gtfs", "model"], ["AAAAAAAA"]))
  page.answers.set("/assets/gtfs-AAAAAAAA.json", async () => "gtfs A")
  page.answers.set("/assets/model-AAAAAAAA.json", async () => "model A")
  page.answers.set("/assets/gtfs-BBBBBBBB.json", async () => "gtfs B")
  const [gtfs, model] = await Promise.all([page.latest<string>("gtfs"), page.latest<string>("model")])
  page.receive(headOf(dataOf(["gtfs", "model"], ["BBBBBBBB"])))
  await vi.advanceTimersByTimeAsync(0)
  expect([gtfs.peek(), model.peek()]).toEqual(["gtfs B", "model A"])
  page.answers.set("/assets/model-BBBBBBBB.json", async () => "model B")
  await vi.advanceTimersByTimeAsync(5_000)
  expect([gtfs.peek(), model.peek()]).toEqual(["gtfs B", "model B"])
  expect(page.fetches.filter(url => url.includes("gtfs-BBBBBBBB")).length).toBe(1)
})

test("a page starts with a fallback when its data can't load the first time, if it has one, and loads the data behind it", async () => {
  const page = await load({ model: "/assets/model-AAAAAAAA.json", gtfs: "/assets/gtfs-AAAAAAAA.json" })
  await expect(page.latest("gtfs")).rejects.toThrow("Load failed")
  const model = await page.latest<string>("model", undefined, () => "empty")
  expect(model.peek()).toBe("empty")
  page.answers.set("/assets/model-AAAAAAAA.json", async () => "learned")
  await vi.advanceTimersByTimeAsync(5_000)
  expect(model.peek()).toBe("learned")
})

test("a data file that doesn't fit its schema fails to load as any other would: first for the fallback, later keeping what was there", async () => {
  const page = await load(dataOf(["model"], ["AAAAAAAA"]))
  page.answers.set("/assets/model-AAAAAAAA.json", async () => ({ version: 2, through: null }))
  const model = await page.latest("model", Model, emptyModel)
  expect(model.peek()).toEqual(emptyModel())
  const learned = { ...emptyModel(), through: "2026-10-06" }
  page.answers.set("/assets/model-AAAAAAAA.json", async () => learned)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(model.peek()).toEqual(learned)
  page.answers.set("/assets/model-BBBBBBBB.json", async () => ({ ...learned, drives: [] }))
  page.receive(headOf(dataOf(["model"], ["BBBBBBBB"])))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(model.peek()).toEqual(learned)
  expect(console.error).toHaveBeenLastCalledWith(new Error("Unexpected JSON from /assets/model-BBBBBBBB.json: drives: Expected an object"))
})

test("a page without a name throws for it", async () => {
  const page = await load({})
  await expect(page.latest("gtfs")).rejects.toThrow("names no data gtfs")
})

test("the page asks for its copy to be checked on coming back into view and every quarter hour in view, and tells the census what it runs", async () => {
  const data = { tiles: "/assets/tiles-AAAAAAAA.json", gtfs: "/assets/gtfs-AAAAAAAA.json" }
  const posted: unknown[] = []
  const received = new EventTarget()
  vi.stubGlobal("navigator", {
    serviceWorker: Object.assign(received, { controller: { postMessage: (message: unknown) => void posted.push(message) }, startMessages: () => {} })
  })
  const page = await load(data)
  vi.stubGlobal("location", { pathname: "/map/", reload: () => {} })
  page.answers.set(data.tiles, async () => ({ version: "2026-10-17", folders: ["/data/map/tiles/2026-10-17/"] }))
  page.answers.set(data.gtfs, async () => ({ stops: [] }))
  await page.latest("tiles")
  expect(posted).toEqual([])
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(posted).toEqual([{ revalidate: "/map/" }])
  document.dispatchEvent(new Event("visibilitychange"))
  expect(posted.length).toBe(2)
  ;(document as unknown as { visibilityState: string }).visibilityState = "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(posted.length).toBe(2)

  const { port1, port2 } = new MessageChannel()
  const answer = new Promise(resolve => port1.onmessage = ({ data }) => resolve(data))
  received.dispatchEvent(Object.assign(new Event("message"), { data: { census: true }, ports: [port2] }))
  expect(await answer).toEqual({
    build: { release: RELEASE, code: ["/assets/index-AAAAAAAA.js"], data },
    retain: { files: [], folders: ["/data/map/tiles/2026-10-17/"] }
  })
  port1.close()

  // A newer file still loading is reported too, so the cache keeps it for the page's next try, and the one loaded until then
  const slow = "/assets/tiles-BBBBBBBB.json"
  page.answers.set(slow, () => new Promise(() => {}))
  page.receive(headOf({ ...data, tiles: slow }))
  const { port1: again1, port2: again2 } = new MessageChannel()
  const later = new Promise(resolve => again1.onmessage = ({ data }) => resolve(data))
  received.dispatchEvent(Object.assign(new Event("message"), { data: { census: true }, ports: [again2] }))
  expect(await later).toEqual({
    build: { release: RELEASE, code: ["/assets/index-AAAAAAAA.js"], data },
    retain: { files: [slow], folders: ["/data/map/tiles/2026-10-17/"] }
  })
  again1.close()
})
