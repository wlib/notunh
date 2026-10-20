// Builds the site once for every browser test, into a folder of its own, which the tests find by NOTUNH_DIST, or
// takes a build already there, as in CI, when NOTUNH_DIST names one

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"

export default async () => {
  const dist = resolve(process.env.NOTUNH_DIST ?? mkdtempSync(join(tmpdir(), "notunh-browser-")))
  process.env.NOTUNH_DIST = dist
  if (!existsSync(join(dist, "sw.js")))
    await build({ logLevel: "warn", build: { outDir: dist } })
}
