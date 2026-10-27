// Lets plain Node load the Worker, which imports JSON as bundlers allow, without import attributes (serve.mts)

import type { ResolveHookSync } from "node:module"

export const resolve: ResolveHookSync = (specifier, context, next) => {
  const resolved = next(specifier, context)
  return resolved.url.endsWith(".json") ? { ...resolved, importAttributes: { type: "json" } } : resolved
}
