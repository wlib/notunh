// Builds the site once for every browser test, into a folder of its own, which the tests find by NOTUNH_DIST, or
// takes a build already there, as in CI, when NOTUNH_DIST names one

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"

export default async () => {
  // An empty NOTUNH_DIST is none, never the repository, which a build there would litter
  const dist = resolve(process.env.NOTUNH_DIST || mkdtempSync(join(tmpdir(), "notunh-browser-")))
  if (dist === process.cwd())
    throw new Error("NOTUNH_DIST names the repository itself")
  process.env.NOTUNH_DIST = dist
  if (!existsSync(join(dist, "sw.js")))
    await build({ logLevel: "warn", build: { outDir: dist } })
}
