// Lets Node load the Worker as wrangler bundles it: JSON imported without import attributes, WebAssembly as a compiled
// module, fonts as their bytes (worker/modules.d.ts), and bruh's JSX compiled (src/shell/served.tsx), which Node
// strips no more than any JSX. Registered by serve.mts, and the same modules are made for vitest by vite.config.mts

import type { LoadHookSync, ResolveHookSync } from "node:module"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"

/** A module whose default export is a binary file as the Worker imports it, by its path, or none for any other file */
export const binaryModule = (path: string) =>
  path.endsWith(".wasm") ? `import { readFileSync } from "node:fs"\nexport default new WebAssembly.Module(readFileSync(${JSON.stringify(path)}))` :
  path.endsWith(".woff") ? `import { readFileSync } from "node:fs"\nexport default new Uint8Array(readFileSync(${JSON.stringify(path)})).buffer` :
                           undefined

export const resolve: ResolveHookSync = (specifier, context, next) => {
  const resolved = next(specifier, context)
  return resolved.url.endsWith(".json") ? { ...resolved, importAttributes: { type: "json" } } : resolved
}

export const load: LoadHookSync = (url, context, next) => {
  const path = url.startsWith("file:") ? fileURLToPath(url) : undefined
  const source =
    path?.endsWith(".tsx") ? transformSync(readFileSync(path, "utf8"), { loader: "tsx", jsx: "automatic", sourcefile: path }).code :
    path ? binaryModule(path) : undefined
  return source ? { format: "module", source, shortCircuit: true } : next(url, context)
}
