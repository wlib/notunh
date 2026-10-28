// The site as it's serving now, so a build can keep what pages already open still ask for (files.mts keepServed
// fetches the files themselves back). The Worker and the pages share one origin: notunh.app, or WORKER_ORIGIN, or
// with --local, `wrangler dev` on localhost:8787

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { buildOf } from "../src/shell/manifest.mts"
import { SITE } from "../src/shell/pages.mts"
import { getJson } from "../src/shared/json.mts"

export const ORIGIN = process.argv.includes("--local") ? "http://localhost:8787" : process.env.WORKER_ORIGIN ?? SITE

/**
 * A JSON file the site serves, parsed by its schema. Undefined, with a warning, when it can't be read or doesn't
 * match: the build then just keeps nothing extra
 */
export const served = async <T,>(path: string, schema: StandardSchemaV1<unknown, T>): Promise<T | undefined> => {
  try {
    return await getJson(ORIGIN + path, { schema })
  }
  catch (error) {
    console.warn(`Couldn't read ${ORIGIN}${path} (${error instanceof Error ? error.message : error})`)
  }
}

/** A data file the deployed page at a path names, by name, as its head does (src/shell/manifest.mts), or undefined as above */
export const deployed = async <T,>(page: string, name: string, schema: StandardSchemaV1<unknown, T>): Promise<T | undefined> => {
  try {
    const response = await fetch(ORIGIN + page)
    if (!response.ok)
      throw new Error(`${response.status}`)
    const url = buildOf(await response.text()).data[name]
    return url === undefined ? undefined : await served(url, schema)
  }
  catch (error) {
    console.warn(`Couldn't read what ${ORIGIN}${page} serves as ${name} (${error instanceof Error ? error.message : error})`)
  }
}
