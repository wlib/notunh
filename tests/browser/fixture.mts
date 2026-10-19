// A server that serves one release of the built site at a time, as the real origin does across deploys, and can be
// told to publish another, to go offline, as a phone with no signal sees it, or to answer a path with an error. The
// releases are made from one build: B renames the dining page's entry chunk and bumps the release, as newer code
// would, C renames the dining index and changes a hall's name in it, as newer data would, and D is C with a service
// worker of other bytes, as a release changing the worker itself would be

import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
import type { AddressInfo } from "node:net"

export const RELEASES = ["A", "B", "C", "D"] as const

/** How release C renames the first dining hall, so a page showing it has shown C's data */
export const HALL_SUFFIX = " (C)"
export type ReleaseName = typeof RELEASES[number]

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".pbf":  "application/x-protobuf"
}

/** The page a path is served by, as the Worker serves them: each laundry room's is the laundry page */
const pageFileOf = (pathname: string) => {
  const page = pathname.startsWith("/laundry/") ? "/laundry/" : pathname
  return page.endsWith("/") ? `${page}index.html` : undefined
}

type Release = { pages: Map<string, string>, files: Map<string, Buffer> }

const releaseAt = (name: ReleaseName) =>
  `2026-10-${18 + RELEASES.indexOf(name)}T08:00:00.000Z`

/** The releases, made from the build: a page's HTML and the files only that release has, over the build's own */
const deriveReleases = (dist: string): Record<ReleaseName, Release> => {
  const html = readFileSync(join(dist, "dining/index.html"), "utf8")
  const withRelease = (html: string, name: ReleaseName) =>
    html.replace(/<meta name="release" content="[^"]*">/, `<meta name="release" content="${releaseAt(name)}">`)
  const entry = html.match(/src="(\/assets\/dining\/index-[\w-]+\.js)"/)![1]
  const index = html.match(/href="(\/assets\/menus-[\w-]+\.json)"/)![1]
  const renamed = (path: string, hash: string) => path.replace(/-[\w-]+(\.\w+)$/, `-${hash}$1`)
  const entryB = renamed(entry, "BBBBBBBB")
  const indexC = renamed(index, "CCCCCCCC")
  const menus = JSON.parse(readFileSync(join(dist, index), "utf8"))
  menus.halls[0].name += HALL_SUFFIX
  const pageC = withRelease(html.replace(entry, entryB).replace(index, indexC), "C")
  const filesC: [string, Buffer][] = [[entryB, readFileSync(join(dist, entry))], [indexC, Buffer.from(JSON.stringify(menus))]]
  return {
    A: { pages: new Map([["/dining/index.html", withRelease(html, "A")]]), files: new Map() },
    B: { pages: new Map([["/dining/index.html", withRelease(html.replace(entry, entryB), "B")]]), files: new Map([[entryB, readFileSync(join(dist, entry))]]) },
    C: { pages: new Map([["/dining/index.html", pageC]]), files: new Map(filesC) },
    D: { pages: new Map([["/dining/index.html", withRelease(pageC, "D")]]), files: new Map([...filesC, ["/sw.js", Buffer.concat([Buffer.from("// Release D\n"), readFileSync(join(dist, "sw.js"))])]]) }
  }
}

export const startFixture = async (dist: string) => {
  const releases = deriveReleases(dist)
  let published: ReleaseName = "A"
  let isOffline = false
  const statuses = new Map<string, number>()
  /** Every path asked for, in order */
  const requests: string[] = []

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url!, "http://localhost")
    const control = pathname.match(/^\/__(publish|offline|online|status)(?:\/(.*))?$/)
    if (control) {
      const [, command, argument = ""] = control
      if (command === "publish")
        published = argument as ReleaseName
      else if (command === "offline" || command === "online")
        isOffline = command === "offline"
      else {
        const [code, ...path] = argument.split("/").reverse()
        statuses.set(`/${path.reverse().join("/")}`, +code)
      }
      return response.writeHead(204).end()
    }
    requests.push(pathname)
    if (isOffline)
      return request.socket.destroy()
    if (statuses.has(pathname))
      return response.writeHead(statuses.get(pathname)!).end()
    if (pathname.startsWith("/api/"))
      return response.writeHead(503).end()

    const release = releases[published]
    const file = pageFileOf(pathname)
    const headers = { "content-type": TYPES[extname(file ?? pathname)] ?? "application/octet-stream", "cache-control": file || pathname === "/sw.js" ? "no-cache" : "public, max-age=31536000, immutable" }
    if (file && release.pages.has(file))
      return response.writeHead(200, headers).end(release.pages.get(file))
    if (release.files.has(pathname))
      return response.writeHead(200, headers).end(release.files.get(pathname))
    const path = join(dist, file ?? pathname)
    if (!existsSync(path) || !path.startsWith(dist))
      return response.writeHead(404).end("Not found")
    response.writeHead(200, headers).end(readFileSync(path))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  const tell = (path: string) => fetch(origin + path, { method: "POST" }).then(() => {})
  return {
    origin,
    requests,
    publish:    (name: ReleaseName) => tell(`/__publish/${name}`),
    setOffline: (offline: boolean) => tell(offline ? "/__offline" : "/__online"),
    setStatus:  (path: string, code: number) => tell(`/__status${path}/${code}`),
    /** What a release's dining page names, by its HTML */
    pageOf:     (name: ReleaseName) => releases[name].pages.get("/dining/index.html")!,
    close:      () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export type Fixture = Awaited<ReturnType<typeof startFixture>>
