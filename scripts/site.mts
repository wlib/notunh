// The site as it's serving now, for a build to keep what pages already open still ask for: the Worker and the
// pages are one origin, notunh.app, or WORKER_ORIGIN, or with --local, `wrangler dev` on localhost:8787

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { buildOf } from "../src/shell/manifest.mts"
import { getJson } from "../src/shared/json.mts"

export const ORIGIN = process.argv.includes("--local") ? "http://localhost:8787" : process.env.WORKER_ORIGIN ?? "https://notunh.app"

/**
 * A data file the deployed page at a path names, by name, as its head does (src/shell/manifest.mts), or undefined
 * when the site or the file can't be read, or isn't as its schema says, which is worth a warning and no more: the
 * build then keeps nothing extra
 */
export const deployed = async <T,>(page: string, name: string, schema: StandardSchemaV1<unknown, T>): Promise<T | undefined> => {
  try {
    const response = await fetch(ORIGIN + page)
    if (!response.ok)
      throw new Error(`${response.status}`)
    const url = buildOf(await response.text()).data[name]
    return url === undefined ? undefined : await getJson(ORIGIN + url, { schema })
  }
  catch (error) {
    console.warn(`Couldn't read what ${ORIGIN}${page} serves as ${name} (${error instanceof Error ? error.message : error})`)
  }
}
