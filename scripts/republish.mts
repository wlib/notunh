// Rolls the site back by publishing a build made before as new: every page of a built site is stamped as published
// now, after it was built, so open pages and the service worker, which never go back to a copy published before the
// one they have, take it in over whatever was published since, and not what it replaced again from an edge not yet
// caught up (src/shell/manifest.mts). Run on the folder a build of the release to go back to wrote, then deploy it:
// node scripts/republish.mts <folder>

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const PUBLISHED = /<meta name="published" content="[^"]*">/
const RELEASE = /<meta name="release" content="[^"]*">/

/** A page's HTML stamped as published at an instant, in place of any stamp it had */
export const republished = (html: string, at: Date) => {
  const stamp = `<meta name="published" content="${at.toISOString()}">`
  if (!RELEASE.test(html))
    throw new Error("Not a page of a release")
  return PUBLISHED.test(html) ? html.replace(PUBLISHED, stamp) : html.replace(RELEASE, release => release + stamp)
}

if (import.meta.main) {
  const [folder] = process.argv.slice(2)
  if (!folder)
    throw new Error("Usage: node scripts/republish.mts <folder>")
  const at = new Date()
  const pages = (await readdir(folder, { recursive: true })).filter(file => file.endsWith(".html"))
  for (const page of pages)
    await writeFile(join(folder, page), republished(await readFile(join(folder, page), "utf8"), at))
  console.log(`${pages.length} pages of ${folder} published as of ${at.toISOString()}`)
}
