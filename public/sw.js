// Offline support for the pages and data already visited. Hashed assets never change and live data is never
// cached, but the icons and manifest keep their names across releases

const CACHE = "app-v1"

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.add("/"))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

// The schedule and menus get a new hash every night, so each replaces the copies before it
const DATA = /^\/assets\/([\w-]+)-[\w-]{8}\.json$/

const store = async (request, response) => {
  if (!response.ok)
    return response

  const cache = await caches.open(CACHE)
  const name = new URL(request.url ?? request, location.origin).pathname.match(DATA)?.[1]
  if (name)
    for (const old of await cache.keys())
      if (new URL(old.url).pathname.match(DATA)?.[1] === name)
        await cache.delete(old)
  await cache.put(request, response.clone())
  return response
}

// A page names the data files it still uses, and the rest under the same folder can go
self.addEventListener("message", event => {
  const { keep } = event.data ?? {}
  if (!Array.isArray(keep) || !keep.length)
    return
  const folder = keep[0].slice(0, keep[0].lastIndexOf("/") + 1)
  const kept = new Set(keep)
  event.waitUntil(
    caches.open(CACHE)
      .then(async cache => {
        for (const request of await cache.keys()) {
          const { pathname } = new URL(request.url)
          if (pathname.startsWith(folder) && !kept.has(pathname))
            await cache.delete(request)
        }
      })
  )
})

const isBrandAsset = pathname =>
  pathname === "/manifest.webmanifest" || /^\/icon(-\d+(-maskable)?)?\.(svg|png)$/.test(pathname)

self.addEventListener("fetch", event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== location.origin)
    return

  // Pages, icons, and the manifest: fresh when online, cached when not, with pages falling back to the home page
  if (request.mode === "navigate")
    event.respondWith(
      fetch(request)
        .then(response => store(url.pathname, response))
        .catch(async () => await caches.match(url.pathname) ?? caches.match("/"))
    )
  else if (isBrandAsset(url.pathname))
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then(response => store(request, response))
        .catch(() => caches.match(request))
    )
  // Everything else: cached first, filled on first use
  else
    event.respondWith(
      caches.match(request)
        .then(cached => cached ?? fetch(request).then(response => store(request, response)))
    )
})
