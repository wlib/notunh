// A server that serves one release of the built site at a time, as the real origin does across deploys, with the
// headers Cloudflare gives static assets: its own, and the build's _headers over them. It can be told to publish
// another, to go offline, as a phone with no signal sees it, to answer a path with an error, or to send data files
// slowly, as a phone on a poor signal gets them. Given a Worker's origin (tests/worker/serve.mts), it hands the API
// and the pins' pages to it, as Cloudflare runs the Worker first for those; without one, the API is down. The
// releases are made from one build. B renames the dining page's entry chunk and bumps the release, as newer code
// would. C renames the dining index too and changes a hall's name in it, as newer data would. D is C with a service
// worker of other bytes, as a release changing the worker itself would be. R is A published again after them all, as
// rolling back to it is (scripts/republish.mts).
//
// H is the release production served before pages named their data, with its own worker (app-v1): the home and
// dining pages and what they name of commit 061f33e's build, as `git worktree add` of that commit, `npm ci`, and
// `vite build` made it with tests/fixtures/data/ as its data, kept in release-061f33e/. Its dining files are the
// fixtures'

import { createServer } from "node:http"
import { readFileSync, existsSync, globSync } from "node:fs"
import { join, extname } from "node:path"
import type { AddressInfo } from "node:net"
import { republished } from "../../scripts/republish.mts"

export const RELEASES = ["A", "B", "C", "D", "R", "H"] as const

const HISTORICAL = new URL("release-061f33e/", import.meta.url).pathname
const DINING_FIXTURES = new URL("../fixtures/data/public/", import.meta.url).pathname

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

const USAGE_ORIGIN = /(<meta name="usage-origin" content=")[^"]*"/

/** What Cloudflare answers any static asset with, short of a page's own headers and the build's _headers */
const CACHE_CONTROL = "public, max-age=0, must-revalidate"

/** The headers the build's _headers file gives each path pattern, of which every match applies */
const headerRules = (dist: string) => {
  const rules: { path: RegExp, headers: Record<string, string> }[] = []
  const file = join(dist, "_headers")
  for (const line of existsSync(file) ? readFileSync(file, "utf8").split("\n") : [])
    if (/^\s+\S/.test(line)) {
      const [, name, value] = line.match(/^\s+([^:]+):\s*(.*)$/)!
      rules.at(-1)!.headers[name.toLowerCase()] = value
    }
    else if (line.trim() && !line.startsWith("#"))
      rules.push({ path: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`), headers: {} })
  return (pathname: string) => Object.assign({}, ...rules.filter(({ path }) => path.test(pathname)).map(({ headers }) => headers))
}

/** The page a path is served by, as the Worker serves them: each laundry room's is the laundry page */
const pageFileOf = (pathname: string) => {
  const page = pathname.startsWith("/laundry/") ? "/laundry/" : pathname
  return page.endsWith("/") ? `${page}index.html` : undefined
}

/** Whether the Worker answers a path before the assets: the API, and each pin's page, but not the pin page itself */
const isWorkerFirst = (pathname: string) =>
  pathname.startsWith("/api/") || /^\/p\/.+/.test(pathname)

type Release = { pages: Map<string, string>, files: Map<string, Buffer> }

const releaseAt = (name: ReleaseName) =>
  `2026-10-${18 + RELEASES.indexOf(name)}T08:00:00.000Z`

/** Every file under a folder, by its path from the origin */
const filesUnder = (folder: string, pattern = "**/*") =>
  new Map(globSync(pattern, { cwd: folder, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return [`/${path.slice(folder.length)}`, readFileSync(path)]
  }))

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
    D: { pages: new Map([["/dining/index.html", withRelease(pageC, "D")]]), files: new Map([...filesC, ["/sw.js", Buffer.concat([Buffer.from("// Release D\n"), readFileSync(join(dist, "sw.js"))])]]) },
    R: { pages: new Map([["/dining/index.html", republished(withRelease(html, "A"), new Date(releaseAt("R")))]]), files: new Map() },
    H: {
      pages: new Map(["/index.html", "/dining/index.html"].map(page => [page, readFileSync(join(HISTORICAL, page), "utf8")])),
      files: new Map([...filesUnder(HISTORICAL), ...filesUnder(DINING_FIXTURES, "data/dining/*")])
    }
  }
}

/** Serves the build, standing in for notunh.app if asked, as the origin usage stats are sent from (src/shell/Head.tsx) */
export const startFixture = async (dist: string, { isUsageOrigin = false, worker }: { isUsageOrigin?: boolean, worker?: string } = {}) => {
  const releases = deriveReleases(dist)
  const headersOf = headerRules(dist)
  let published: ReleaseName = "A"
  let isOffline = false
  let dataDelay = 0
  let origin = ""
  const statuses = new Map<string, number>()
  /** Every path asked for, in order */
  const requests: string[] = []

  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url!, "http://localhost")
    const control = pathname.match(/^\/__(publish|offline|online|status|delay)(?:\/(.*))?$/)
    if (control) {
      const [, command, argument = ""] = control
      if (command === "publish")
        published = argument as ReleaseName
      else if (command === "offline" || command === "online")
        isOffline = command === "offline"
      else if (command === "delay")
        dataDelay = +argument
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
    if (isWorkerFirst(pathname)) {
      if (!worker)
        return response.writeHead(503).end()
      const chunks: Buffer[] = []
      for await (const chunk of request)
        chunks.push(chunk as Buffer)
      const answer = await fetch(worker + request.url, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => typeof value === "string" && name !== "host") as [string, string][]),
        body: chunks.length ? Buffer.concat(chunks) : undefined
      })
      response.writeHead(answer.status, Object.fromEntries([...answer.headers].filter(([name]) => !["content-encoding", "transfer-encoding", "content-length"].includes(name))))
      return response.end(Buffer.from(await answer.arrayBuffer()))
    }

    const release = releases[published]
    const file = pageFileOf(pathname)
    const headers = { "content-type": TYPES[extname(file ?? pathname)] ?? "application/octet-stream", "cache-control": file || pathname === "/sw.js" ? "no-cache" : CACHE_CONTROL, ...file ? {} : headersOf(pathname) }
    // A file's path as it's named on disk, as a URL escapes its spaces, like the style's "Noto Sans Regular" fonts
    const path = join(dist, file ?? decodeURIComponent(pathname))
    const found = file && release.pages.get(file) || release.files.get(pathname) || (existsSync(path) && path.startsWith(dist) ? readFileSync(path) : undefined)
    const body = file && found && isUsageOrigin ? found.toString().replace(USAGE_ORIGIN, `$1${origin}"`) : found
    if (body === undefined)
      return response.writeHead(404).end("Not found")
    setTimeout(() => response.writeHead(200, headers).end(body), pathname.endsWith(".json") ? dataDelay : 0)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${port}`
  const tell = (path: string) => fetch(origin + path, { method: "POST" }).then(() => {})
  return {
    origin,
    requests,
    publish:    (name: ReleaseName) => tell(`/__publish/${name}`),
    setOffline: (offline: boolean) => tell(offline ? "/__offline" : "/__online"),
    setStatus:  (path: string, code: number) => tell(`/__status${path}/${code}`),
    /** Sends every data file this many milliseconds late */
    setDelay:   (ms: number) => tell(`/__delay/${ms}`),
    /** What a release's dining page names, by its HTML */
    pageOf:     (name: ReleaseName) => releases[name].pages.get("/dining/index.html")!,
    close:      () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export type Fixture = Awaited<ReturnType<typeof startFixture>>
