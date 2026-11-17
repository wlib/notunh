// Buildings' photos (src/places/profiles.mts), served from our origin so phones never ask Wikimedia or Flickr, whose
// limits a campus sharing a few addresses runs into, nor load a photo whole: GET /api/photo?src=<url>&w=<width>, a
// photo the served build's profiles show, by its address there, at one of the widths pages ask for, and nothing else,
// so this is neither an open proxy nor a way to run up transformations. Each is fetched as published, made no wider
// than asked as WebP, which every browser we serve takes, by the Images binding, and kept at the edge and in browsers
// for good, as an address is always the same photo

import { Hono } from "hono/tiny"
import { PHOTO_WIDTHS, Profiles, photoSrc } from "../src/places/profiles.mts"
import { HEADERS } from "./collect.mts"
import type { Env } from "./env.mts"
import { named } from "./site.mts"

type Worker = { Bindings: Env }

export const photos = new Hono<Worker>()

/** A photo's source answering slower than this has stalled */
const UPSTREAM_MS = 15_000

photos.get("/api/photo", async c => {
  const src = c.req.query("src")
  const width = PHOTO_WIDTHS.find(width => String(width) === c.req.query("w"))
  if (src === undefined || width === undefined)
    return c.notFound()
  // Keyed by what's served alone, so a made-up query can't skip the cache and have the photo fetched and made again
  const key = new Request(new URL(photoSrc(src, width), c.req.url))
  const cache = typeof caches === "undefined" ? undefined : caches.default
  const kept = await cache?.match(key)
  if (kept)
    return kept
  try {
    const { profiles } = await named(c.env.ASSETS, "profiles", Profiles)
    if (!Object.values(profiles).some(({ photos }) => photos.some(photo => photo.url === src)))
      return c.notFound()
    const fetched = await fetch(src, { headers: HEADERS, signal: AbortSignal.timeout(UPSTREAM_MS) })
    if (!fetched.ok)
      throw new Error(`${src} is ${fetched.status}`)
    const made = await c.env.IMAGES.input(fetched.body!).transform({ width, fit: "scale-down" }).output({ format: "image/webp" })
    const photo = made.response({ headers: { "cache-control": "public, max-age=31536000, immutable" } })
    if (cache)
      c.executionCtx.waitUntil(cache.put(key, photo.clone()))
    return photo
  }
  catch (error) {
    console.warn(error)
    return c.text("The photo couldn't be fetched", 502, { "cache-control": "no-store" })
  }
})
