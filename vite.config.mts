import { defineConfig, type Rollup } from "vite"
import bruh from "vite-plugin-bruh"

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
    bruh()
  ],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: packageChunk
      }
    },
    // maplibre alone is just over 1 MB
    chunkSizeWarningLimit: 1100
  },
  worker: {
    format: "es"
  },
  optimizeDeps: {
    exclude: ["bruh"]
  }
})
