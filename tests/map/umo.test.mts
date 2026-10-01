import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { fetchPredictions } from "../../src/map/umo.mts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const pair = fc.record({
  route: fc.stringMatching(/^[A-Za-z0-9]{1,10}$/),
  stop:  fc.stringMatching(/^[0-9]{1,4}$/)
})

test("fetchPredictions asks for every pair, in order, in URLs the API accepts", async () =>
  fc.assert(fc.asyncProperty(fc.array(pair, { maxLength: 400 }), async pairs => {
    const urls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url)
      return new Response("[]")
    })

    await fetchPredictions(pairs)

    for (const url of urls)
      expect(url.length).toBeLessThanOrEqual(1024)
    const requested = urls.flatMap(url => url.match(/nstops\/(.*)\/predictions/)![1].split(","))
    expect(requested).toEqual(pairs.map(({ route, stop }) => `${route}:${stop}`))
  }))
)
