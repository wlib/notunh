import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { arrayOf } from "../../src/shared/json.mts"
import { fakePage, leavePage } from "./page.mts"

afterEach(leavePage)

const URL = "/data/dining/MENUMENUMENU.json"

/**
 * The loader, with a cache in front of the network as the service worker keeps one: what it holds is answered unless
 * a request says cache: "reload", which fetches afresh and keeps the answer in its place
 */
const load = async (cached: unknown, network: () => unknown) => {
  const page = fakePage({ at: Date.UTC(2026, 9, 7, 16) })
  const cache = new Map([[URL, cached]])
  const inits: RequestInit[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    inits.push(init)
    if (init.cache !== "reload" && cache.has(url))
      return Response.json(cache.get(url))
    const answer = network()
    if (answer === undefined)
      throw new TypeError("Load failed")
    cache.set(url, answer)
    return Response.json(answer)
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
  return { page, cache, inits, ...await import("../../src/shell/load.mts") }
}

test("a malformed copy a cache kept of a file is replaced from the network on the next try, and the file loads", async () =>
  fc.assert(fc.asyncProperty(fc.constantFrom({}, "<!doctype html>", null, 3), fc.nat(3), async (malformed, outage) => {
    let failures = outage
    const { cache, inits, loadImmutable, jsonOf } = await load(malformed, () => failures-- > 0 ? undefined : [{ meal: "lunch" }])
    const errors: unknown[] = []
    const loading = loadImmutable(URL, jsonOf(arrayOf()), { onError: error => errors.push(error) })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await loading).toEqual([{ meal: "lunch" }])
    expect(cache.get(URL)).toEqual([{ meal: "lunch" }])
    expect(errors).toHaveLength(1 + outage)
    expect(inits.map(init => init.cache)).toEqual(["default", ...Array(1 + outage).fill("reload")])
  }))
)

test("retries back off, come at once when the page comes back into view, and stop once the file isn't wanted", async () => {
  const { page, inits, loadImmutable, jsonOf } = await load(undefined, () => undefined)
  const controller = new AbortController()
  const loading = loadImmutable("/data/dining/GONEGONEGONE.json", jsonOf(arrayOf()), { signal: controller.signal })
  const tries = () => inits.length
  await vi.advanceTimersByTimeAsync(0)
  expect(tries()).toBe(1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(tries()).toBe(2)
  page.setVisibility("hidden")
  page.setVisibility("visible")
  await vi.advanceTimersByTimeAsync(0)
  expect(tries()).toBe(3)
  controller.abort()
  await expect(loading).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(tries()).toBe(3)
})
