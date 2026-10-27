// What the cache keeps: the closure of every generation still in use, and nothing else. A generation is in use if it
// is a cached page's current or previous copy, or if an open window says it runs it. A data file can ask for more
// than itself through the Retain shape (src/shell/manifest.mts): the map style requires its style.json, the dining,
// courses and prerequisites indexes list their files, and the tiles and style name their folders. So the worker knows
// nothing of any of them

import { type Build, type Generation, buildOf, isRetained, mergedRetain, retainOf } from "../shell/manifest.mts"

/** The part of a Cache the worker uses, which tests stand in for */
export type CacheLike = Pick<Cache, "keys" | "match" | "put" | "delete">

// Files are the same whoever asks. A server may still say they vary by Origin, which a module script's request
// carries and the worker's own fetches don't, so matches ignore Vary
export const ANY = { ignoreVary: true }

/** The page a path is served by: each laundry room's, like /laundry/adams-tower/, is the laundry page, and each pin's, like /p/abc, the pin page */
export const pageOf = (pathname: string) =>
  pathname.startsWith("/laundry/") ? "/laundry/" :
  pathname.startsWith("/p/")       ? "/p/" :
                                     pathname

const isPage = (pathname: string) =>
  pathname.endsWith("/")

export const isBrandAsset = (pathname: string) =>
  pathname === "/manifest.webmanifest" || /^\/icon(-\d+(-maskable)?)?\.(svg|png)$/.test(pathname)

/** Where the build puts files named by their content hash or their data version, so a URL's bytes never change */
export const isHashed = (pathname: string) =>
  pathname.startsWith("/assets/") || pathname.startsWith("/data/")

const pathOf = (request: Request) =>
  new URL(request.url).pathname

/** A build's generation: the build, plus what its data files (as cached) ask the cache to retain */
export const generationOf = async (cache: CacheLike, build: Build): Promise<Generation> => {
  const retains = await Promise.all(Object.values(build.data).map(async url =>
    retainOf(await (await cache.match(url, ANY))?.json().catch(() => undefined))
  ))
  return { build, retain: mergedRetain(retains) }
}

/** Deletes every file no generation needs, counting the cached pages' and those the live windows report running */
export const prune = async (cache: CacheLike, live: () => Promise<Generation[]>) => {
  const requests = await cache.keys()
  const cached = await Promise.all(requests.filter(request => isPage(pathOf(request))).map(async request =>
    generationOf(cache, buildOf(await (await cache.match(request))!.text()))
  ))
  const keep = isRetained([...cached, ...await live()])
  await deleteWhere(cache, pathname => !isPage(pathname) && !isBrandAsset(pathname) && !keep(pathname))
}

export const deleteWhere = async (cache: CacheLike, test: (pathname: string) => boolean) => {
  for (const request of await cache.keys())
    if (test(pathOf(request)))
      await cache.delete(request)
}
