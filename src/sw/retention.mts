// What the cache keeps: the closure of every generation still in use, which is each cached page's current and
// previous, and whatever the open windows say they run, and nothing else. A data file can ask for more than itself,
// by the Retain shape (src/shell/manifest.mts): the style requires its style.json, the dining index names its
// files, and the tiles and style their folders, so the worker needs to know nothing of any of them

import { type Build, type Generation, buildOf, isRetained, mergedRetain, retainOf } from "../shell/manifest.mts"

/** The part of a Cache the worker uses, which tests stand in for */
export type CacheLike = Pick<Cache, "keys" | "match" | "put" | "delete">

// Files are the same whoever asks, though a server may say they vary by Origin, which a module script's request
// has and the worker's own fetches don't
export const ANY = { ignoreVary: true }

/** The page a path is served by: each laundry room's, like /laundry/adams-tower/, is the laundry page */
export const pageOf = (pathname: string) =>
  pathname.startsWith("/laundry/") ? "/laundry/" : pathname

const isPage = (pathname: string) =>
  pathname.endsWith("/")

export const isBrandAsset = (pathname: string) =>
  pathname === "/manifest.webmanifest" || /^\/icon(-\d+(-maskable)?)?\.(svg|png)$/.test(pathname)

/** Where the build puts files named by what's in them, or by the version they're of, which never change */
export const isHashed = (pathname: string) =>
  pathname.startsWith("/assets/") || pathname.startsWith("/data/")

const pathOf = (request: Request) =>
  new URL(request.url).pathname

/** A build's generation: the build, and what the data files it names, as cached, ask of the cache */
export const generationOf = async (cache: CacheLike, build: Build): Promise<Generation> => {
  const retains = await Promise.all(Object.values(build.data).map(async url =>
    retainOf(await (await cache.match(url, ANY))?.json().catch(() => undefined))
  ))
  return { build, retain: mergedRetain(retains) }
}

/** Lets go of everything no generation needs: not the cached pages', nor those the windows asked report running */
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
