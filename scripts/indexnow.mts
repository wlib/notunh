// Tells the search engines that share IndexNow (Bing, Yandex, Naver, Seznam, Yep) which pages a deploy changed, so
// they come for them soon. Google takes no part: its Indexing API is only for job postings and livestreams, and its
// sitemap ping is gone, so it reads the sitemap (search.mts) when it next crawls.
//
// Run by npm's postdeploy, once `wrangler deploy` has put the build live. Only Workers Builds' deploys of main submit,
// which are all of production's: every push to main and every rebuild the workflows ask for with the deploy hook. A
// page changed if its lastmod beside the sitemap just deployed (/sitemap.json, search.mts) is this build's release, so
// a rebuild that changed nothing submits nothing, and a night's new menus and events submit those pages alone. A
// submission that fails is only warned of, as the deploy is done by then

import { readFile } from "node:fs/promises"
import { buildOf } from "../src/shell/manifest.mts"
import { INDEXNOW_KEY, SITE } from "../src/shell/pages.mts"
import * as v from "valibot"
import { DIST, Fingerprints } from "./search.mts"

export const ENDPOINT = "https://api.indexnow.org/indexnow"

/** How many pages IndexNow takes in a request */
export const BATCH = 10_000

/** The pages a build changed: those its sitemap's fingerprints say last changed at its release */
export const changedOf = (fingerprints: Fingerprints, release: string) =>
  Object.entries(fingerprints).filter(([, [, lastmod]]) => lastmod === release).map(([loc]) => loc)

/** Submits pages to IndexNow, if any, in as few requests as it takes. It answers 200 or 202 when it takes them */
export const submit = async (urls: string[], load = fetch) => {
  if (!urls.length)
    return console.log("No page changed, so none is submitted")
  const { host } = new URL(SITE)
  for (let start = 0; start < urls.length; start += BATCH) {
    const urlList = urls.slice(start, start + BATCH)
    const response = await load(ENDPOINT, {
      method:  "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body:    JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList })
    })
    if (!response.ok)
      throw new Error(`IndexNow answered ${response.status} for ${urlList.length} pages from ${urlList[0]}`)
  }
  console.log(`Submitted ${urls.length} pages: ${urls.slice(0, 5).join(", ")}${urls.length > 5 ? ", …" : ""}`)
}

if (import.meta.main) {
  if (process.env.WORKERS_CI_BRANCH !== "main")
    console.log("Not a Workers Builds deploy of main, so nothing is submitted")
  else {
    const read = (path: string) => readFile(new URL(path, DIST), "utf8")
    const { release } = buildOf(await read("index.html"))
    await submit(changedOf(v.parse(Fingerprints, JSON.parse(await read("sitemap.json"))), release)).catch(error => console.warn(error.message))
  }
}
