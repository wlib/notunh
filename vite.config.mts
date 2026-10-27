import { resolve } from "node:path"
import { build, defineConfig, type Connect, type Rollup } from "vite"
import bruh from "vite-plugin-bruh"
import browserslist from "browserslist"
import esbuildTargets from "browserslist-to-esbuild"
import { browserslistToTargets } from "lightningcss"

// The browsers in package.json, so JS and CSS are lowered only as far as the oldest of them needs
const browsers = browserslist()

const packageOf = (id: string) =>
  id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]

/**
 * Each package the app imports in a chunk of its own, along with what it imports in turn,
 * so changing the app doesn't make anyone download maplibre again
 */
const packageChunk = (id: string, { getModuleInfo }: Rollup.ManualChunkMeta) => {
  const seen = new Set([id])
  let module = id
  while (true) {
    const importer = getModuleInfo(module)?.importers[0]
    if (!importer || !packageOf(importer) || seen.has(importer))
      return packageOf(module)?.replace("@", "").replace("/", "-")
    seen.add(module = importer)
  }
}

// Where the pages are built, for the service worker to be built beside them
let outDir = "dist"

// A laundry room's own path, like /laundry/adams-tower/, which the Worker answers with the laundry page, and a pin's,
// like /p/abc123, which it answers with the pin page
const ROOM = /^\/laundry\/[\w-]+\/$/
const PIN = /^\/p\/[\w-]+$/

/**
 * A page by its path alone, as bruh looks pages up by the whole URL, query and all, and each laundry room as the
 * laundry page. The browser keeps the real URL, so the page still reads its query
 */
const toPage: Connect.NextHandleFunction = (request, _, next) => {
  const path = request.url?.split("?")[0]
  if (path?.endsWith("/"))
    request.url = path.replace(ROOM, "/laundry/")
  else if (path && PIN.test(path))
    request.url = "/p/"
  next()
}

export default defineConfig({
  plugins: [
    {
      // bruh 2.0.0-beta.5 declares sideEffects: false, but its Intl modules register custom elements when imported,
      // so without this the build drops them and every date, number, plural, and list renders blank
      name: "retain-bruh-intl-registration",
      transform(code, id) {
        if (/\/node_modules\/bruh\/dist\/components\/intl\/(date-time|number|plural|list)\.mjs$/.test(id))
          return { code, map: null, moduleSideEffects: true }
      }
    },
    {
      // As the Worker does, so pages open with a query, and rooms by their paths, in development and preview too
      name: "page-paths",
      // Before bruh's, which renders pages by their paths
      enforce: "pre",
      configureServer: server => void server.middlewares.use(toPage),
      configurePreviewServer: server => void server.middlewares.use(toPage)
    },
    {
      // A page names everything the service worker keeps for it in its head (src/shell/manifest.mts), but Vite's head
      // names only the code a page starts with. Code it imports later, like PostHog's, and a web worker's script, which
      // only the code starting it names, would never be kept, so each page's head names them too, as prefetches
      name: "name-later-code",
      transformIndexHtml: {
        order: "post",
        handler: (html, { bundle, chunk, path }) => {
          if (!bundle || !chunk)
            return
          // A data file that isn't there is left named as the source, where the rest are assets by now, which
          // would be a page that can't load
          const missing = [...html.matchAll(/href="([^"]*)" data-name="([^"]*)"/g)].filter(([, href]) => !/^(__VITE_ASSET__|\/assets\/)/.test(href))
          if (missing.length)
            throw new Error(`${path} names data not fetched yet: ${missing.map(([, href, name]) => `${name} (${href})`).join(", ")}`)
          /** The chunks reached from the page's own, following its static imports and, if asked, its dynamic ones */
          const reached = (isLater: boolean) => {
            const chunks = [chunk]
            for (const { imports, dynamicImports } of chunks)
              for (const name of isLater ? [...imports, ...dynamicImports] : imports)
                if (!chunks.some(seen => seen.fileName === name) && bundle[name]?.type === "chunk")
                  chunks.push(bundle[name])
            return chunks
          }
          const initial = new Set(reached(false))
          const chunks = reached(true)
          // A worker's script is emitted as an asset named after its module, which is in the chunk that starts it
          const stems = chunks.flatMap(({ modules }) => Object.keys(modules).flatMap(id => id.match(/\/([^/?]+)\.[cm]?[jt]s\?(?:shared)?worker/)?.[1] ?? []))
          const workers = Object.values(bundle).filter(output => output.type === "asset" && stems.some(stem => output.fileName.match(`/${stem}-[\\w-]+\\.js$`)))
          return [...chunks.filter(later => !initial.has(later)), ...workers]
            .map(({ fileName }) => ({ tag: "link", attrs: { rel: "prefetch", href: `/${fileName}` }, injectTo: "head" }))
        }
      }
    },
    {
      // The service worker, from src/sw, built after the pages as one plain script at /sw.js, where they register it
      name: "service-worker",
      apply: "build",
      configResolved(config) {
        outDir = resolve(config.root, config.build.outDir)
      },
      closeBundle: () =>
        build({
          configFile: false,
          logLevel: "warn",
          publicDir: false,
          build: {
            outDir,
            emptyOutDir: false,
            target: esbuildTargets(browsers),
            rollupOptions: {
              input: "src/sw/sw.mts",
              output: { format: "iife", entryFileNames: "sw.js" }
            }
          }
        }).then(() => {})
    },
    bruh()
  ],
  css: {
    transformer: "lightningcss",
    lightningcss: { targets: browserslistToTargets(browsers) }
  },
  build: {
    target: esbuildTargets(browsers),
    cssMinify: "lightningcss",
    // Published beside the code, as the code is open source anyway, so PostHog fetches them to read errors' stacks
    sourcemap: true,
    // Data files are always files of their own, never inlined, so the service worker keeps and versions them as
    // it does code, and a page can tell a newer build's data from its code (src/shell/build.mts)
    assetsInlineLimit: file => file.endsWith(".json") ? false : undefined,
    rollupOptions: {
      output: {
        manualChunks: packageChunk
      }
    },
    // maplibre alone is just over 1 MB
    chunkSizeWarningLimit: 1100
  },
  // The Worker's API, from `npm run worker`, as the built site gets it from the same origin
  server: {
    proxy: {
      "/api": "http://localhost:8787"
    }
  },
  worker: {
    format: "es"
  },
  optimizeDeps: {
    exclude: ["bruh"]
  }
})
