import { defineConfig, type Connect, type Rollup } from "vite"
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

// A laundry room's own path, like /laundry/adams-tower/, which the Worker answers with the laundry page
const ROOM = /^\/laundry\/[\w-]+\/$/

/**
 * A page by its path alone, as bruh looks pages up by the whole URL, query and all, and each laundry room as the
 * laundry page. The browser keeps the real URL, so the page still reads its query
 */
const toPage: Connect.NextHandleFunction = (request, _, next) => {
  const path = request.url?.split("?")[0]
  if (path?.endsWith("/"))
    request.url = path.replace(ROOM, "/laundry/")
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
    bruh()
  ],
  css: {
    transformer: "lightningcss",
    lightningcss: { targets: browserslistToTargets(browsers) }
  },
  build: {
    target: esbuildTargets(browsers),
    cssMinify: "lightningcss",
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
