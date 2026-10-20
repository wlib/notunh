// Offline support for the pages and data already visited. Hashed assets never change and live data is never
// cached, but the icons and manifest keep their names across releases

const CACHE = "app-v1"

// How long a page waits for the network before the copy we have
const PAGE_TIMEOUT_MS = 3000

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

/**
 * The name of a file kept one per name, each replacing the copies before it: the schedule and menus, which get a
 * new hash every night, and maplibre's worker, which its chunk loads rather than any page naming it
 */
const singletonName = pathname =>
  pathname.match(/^\/assets\/([\w-]+)-[\w-]{8}\.json$/)?.[1] ??
  pathname.match(/^\/assets\/(maplibre-gl-worker)-[\w-]{8}\.js$/)?.[1]

const ASSET = /\/assets\/[\w./-]+/g

/** The assets a page's HTML names */
const assetsOf = html =>
  html.match(ASSET) ?? []

const isPage = pathname =>
  pathname.endsWith("/")

/** The page a path is served by: each laundry room's, like /laundry/adams-tower/, is the laundry page */
const pageOf = pathname =>
  pathname.startsWith("/laundry/") ? "/laundry/" : pathname

const store = async (request, response) => {
  if (!response.ok)
    return response

  const cache = await caches.open(CACHE)
  const name = singletonName(new URL(request.url ?? request, location.origin).pathname)
  if (name)
    for (const old of await cache.keys())
      if (singletonName(new URL(old.url).pathname) === name)
        await cache.delete(old)
  await cache.put(request, response.clone())
  return response
}

/** Assets that no cached page's build names any more can go, except those kept one per name */
const prune = async cache => {
  const requests = await cache.keys()
  const named = new Set()
  for (const request of requests)
    if (isPage(new URL(request.url).pathname))
      for (const asset of assetsOf(await (await cache.match(request)).text()))
        named.add(asset)
  for (const request of requests) {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith("/assets/") && !named.has(pathname) && !singletonName(pathname))
      await cache.delete(request)
  }
}

/**
 * Keeps a page for offline, and once a page's build changes, lets go of the old build's assets, unless the old
 * build is still loading them, having been served while the network was slow
 */
const storePage = async (pathname, response, html, isOldBuildLoading) => {
  const cache = await caches.open(CACHE)
  const previous = await (await cache.match(pathname))?.text()
  await cache.put(pathname, response)
  if (previous !== undefined && previous !== html && !isOldBuildLoading)
    await prune(cache)
}

/**
 * The network's answer to a navigation, with the HTML if it's one of our pages. Anything that isn't a page, like a
 * redirect or an error, passes through, but a page that doesn't name our assets is a captive portal's sign-in or
 * the like, answering in place of ours. Telling which takes the whole page, which is only a few kilobytes
 */
const fetchPage = async request => {
  const response = await fetch(request)
  if (!response.ok || !/^text\/html/.test(response.headers.get("content-type") ?? ""))
    return { response }
  const html = await response.clone().text()
  return !response.redirected && assetsOf(html).length
    ? { response, copy: response.clone(), html }
    : { response, isForeign: true }
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
  // The API is live, so it's never cached here
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/"))
    return

  // Pages: fresh if the network answers soon, else the copy we have, else whenever the network does answer, and
  // failing that the home page. A late answer is still kept, so the next visit is fresh
  if (request.mode === "navigate") {
    const fresh = fetchPage(request)
    // Once the wait is over, an older copy may be loading, so its assets are left for the next new build to prune
    let isLate = false
    event.waitUntil(
      fresh
        .then(({ copy, html }) => html && storePage(pageOf(url.pathname), copy, html, isLate))
        .catch(() => {})
    )
    const answer = fresh.then(({ response, isForeign }) => isForeign ? undefined : response, () => undefined)
    const timeout = new Promise(resolve => setTimeout(resolve, PAGE_TIMEOUT_MS))
    event.respondWith(
      Promise.race([answer, timeout])
        .then(async response => {
          if (response)
            return response
          isLate = true
          return (
            await caches.match(pageOf(url.pathname)) ??
            await answer ??
            await caches.match("/") ??
            (await fresh).response
          )
        })
    )
  }
  // Icons and the manifest: fresh when online, cached when not
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
