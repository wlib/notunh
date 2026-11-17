/// <reference types="node" />
// Buildings' photos (worker/photos.mts): a photo the served profiles show, at a width pages ask for, fetched as
// published with our user agent, made that wide in the best format the browser takes, and kept at the edge and in
// browsers for good, once per format; any other
// photo or width isn't found, without asking anyone; and a source or a transformation failing is a 502 kept nowhere

import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { app } from "../../worker/api.mts"
import { formatOf } from "../../worker/photos.mts"
import type { Env } from "../../worker/env.mts"
import { PHOTO_WIDTHS, photoSrc } from "../../src/places/profiles.mts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const PHOTOS = [
  "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a0/Hall%2C_UNH.jpg/1280px-Hall%2C_UNH.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo",
  "https://upload.wikimedia.org/wikipedia/commons/c/c5/Monthly_%281909%29.jpg",
  "https://live.staticflickr.com/970/40002111450_e8bbb8dc51_b.jpg"
]

/** The map page as built, naming its profiles, and the profiles, a building with the photos */
const MAP = `<!doctype html><html><head><meta name="release" content="2026-11-10T08:00:00.000Z"><link rel="data" href="/assets/profiles-x.json" data-name="profiles"></head><body></body></html>`
const PROFILES = {
  ranked:   0,
  profiles: {
    "Hall": {
      name: "Hall", aliases: [], category: "academic", status: "in-use", facts: [], more: [], confidence: "high", sources: {},
      photos: PHOTOS.map(url => ({ url, page: "https://commons.wikimedia.org/wiki/File:Hall.jpg", credit: "A", license: "CC0", view: "exterior", caption: "A hall" }))
    }
  }
}

/**
 * A Worker whose assets are the map page and its profiles, with an edge cache, sources answering as given, and an
 * Images binding that makes of a photo what it was asked to, or fails on what isn't one
 */
const worker = (answer = () => new Response("a photo", { headers: { "content-type": "image/jpeg" } })) => {
  const fetched: Request[] = []
  const made: object[] = []
  const edge = new Map<string, Response>()
  const pending: Promise<unknown>[] = []
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => edge.get(request.url)?.clone(),
      put:   async (request: Request, response: Response) => void edge.set(request.url, response)
    }
  })
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(new Request(input, init))
    return answer()
  })
  const env = {
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input)
        return pathname === "/map/" ? new Response(MAP, { headers: { "content-type": "text/html" } }) : pathname === "/assets/profiles-x.json" ? Response.json(PROFILES) : new Response("", { status: 404 })
      }
    },
    IMAGES: {
      input: (stream: ReadableStream<Uint8Array>) => ({
        transform: (transform: object) => ({
          output: async (output: { format: string }) => {
            if (await new Response(stream).text() !== "a photo")
              throw new Error("Not an image")
            made.push({ transform, output })
            return { response: (init: ResponseInit) => new Response(JSON.stringify({ transform, output }), { headers: { ...init.headers, "content-type": output.format } }) }
          }
        })
      })
    }
  } as unknown as Env
  const get = async (path: string, accept?: string) => {
    const response = await app.fetch(new Request(`https://notunh.app${path}`, { headers: accept === undefined ? {} : { accept } }), env, { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException: () => {}, props: {} })
    await Promise.all(pending)
    return response
  }
  return { get, fetched, made, edge }
}

/** What browsers send for an image, Safari's on a Mac before Ventura without AVIF, and nothing at all */
const ACCEPTS = [
  "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "image/webp,image/avif,image/jxl,image/heic,image/heic-sequence,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5",
  "image/webp,image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5",
  "*/*",
  undefined
]

test("a browser gets the best format it names of AVIF and WebP, else JPEG", () =>
  fc.assert(fc.property(fc.subarray(["image/avif", "image/webp", "image/jxl", "image/png", "*/*"]), names => {
    const format = formatOf(names.join(","))
    expect(format).toBe(names.includes("image/avif") ? "image/avif" : names.includes("image/webp") ? "image/webp" : "image/jpeg")
  }))
)

test("a photo the profiles show is fetched once per format, as published, with our user agent, made the width asked, and kept for good", () =>
  fc.assert(fc.asyncProperty(fc.constantFrom(...PHOTOS), fc.constantFrom(...PHOTO_WIDTHS), fc.constantFrom(...ACCEPTS), async (photo, width, accept) => {
    const { get, fetched, made, edge } = worker()
    const format = formatOf(accept)
    const response = await get(photoSrc(photo, width), accept)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(format)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(response.headers.get("vary")).toBe("accept")
    expect(await response.json()).toEqual({ transform: { width, fit: "scale-down" }, output: { format, quality: 80 } })
    // Asked again, with a made-up query too, it's the edge's, and asked as another format it's made once more
    expect((await get(`${photoSrc(photo, width)}&cache=bust`, accept)).headers.get("content-type")).toBe(format)
    expect(fetched.map(({ url }) => url)).toEqual([photo])
    expect(fetched[0].headers.get("user-agent")).toBe("notunh/1 (+https://notunh.app)")
    const other = format === "image/jpeg" ? "image/webp" : "image/jpeg"
    expect((await get(photoSrc(photo, width), other === "image/webp" ? "image/webp" : "*/*")).headers.get("content-type")).toBe(other)
    expect(made).toHaveLength(2)
    expect(edge.size).toBe(2)
  }), { numRuns: 20 })
)

test("a photo no profile shows, or a width not served, isn't found, without asking any source or making anything", async () => {
  const { get, fetched, made, edge } = worker()
  const src = fc.oneof(fc.constantFrom(...PHOTOS), fc.constantFrom(...PHOTOS).map(photo => photo.replace(/\?.*$|$/, "#x")), fc.webUrl(), fc.string())
  const w = fc.oneof(fc.constantFrom(...PHOTO_WIDTHS).map(String), fc.integer().map(String), fc.string())
  await fc.assert(fc.asyncProperty(src, w, async (src, w) => {
    fc.pre(!PHOTOS.includes(src) || !PHOTO_WIDTHS.map(String).includes(w))
    expect((await get(`/api/photo?${new URLSearchParams({ src, w })}`)).status).toBe(404)
  }), { numRuns: 50 })
  expect((await get("/api/photo")).status).toBe(404)
  expect(fetched).toEqual([])
  expect(made).toEqual([])
  expect(edge.size).toBe(0)
})

test("a source refusing, failing, unreachable or answering other than a photo is a 502 kept nowhere", async () => {
  const failures = [
    () => new Response("", { status: 429 }),
    () => new Response("", { status: 404 }),
    () => new Response("", { status: 503 }),
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    () => { throw new TypeError("Network down") }
  ]
  for (const failure of failures) {
    const { get, fetched, edge } = worker(failure)
    const response = await get(photoSrc(PHOTOS[0], 500))
    expect(response.status).toBe(502)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(fetched).toHaveLength(1)
    expect(edge.size).toBe(0)
  }
})
