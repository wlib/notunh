// The site as the Worker reads it from its own assets: the map page's head is the build's manifest, naming every data
// file by name (src/shell/manifest.mts), so the Worker reads the files the pages do, by their hashed paths, each read
// once in the isolate for as long as the release naming it is served

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type Build, buildOf } from "../src/shell/manifest.mts"
import { readJson } from "../src/shared/json.mts"
import { getOrCreate } from "../src/shared/group.mts"
import { SITE } from "../src/shell/pages.mts"

/** Each data file read, by its path, for the release last seen */
const read = new Map<string, Promise<unknown>>()
let release = ""

/** What the map page served now says of its build: its release and its data files by name */
export const siteBuild = async (assets: Fetcher): Promise<Build> => {
  const page = await assets.fetch(`${SITE}/map/`)
  if (!page.ok)
    throw new Error(`The map page is ${page.status}`)
  const build = buildOf(await page.text())
  // A newer release names other files, so the old ones are let go
  if (build.release !== release) {
    read.clear()
    release = build.release
  }
  return build
}

/** A file of the site, by its path, as `parse` makes its response, read once; one that fails is read again next time */
export const dataOf = <T,>(assets: Fetcher, path: string, parse: (response: Response) => Promise<T>) => {
  const data = getOrCreate(read, path, () => assets.fetch(new URL(path, SITE).href).then(parse)) as Promise<T>
  data.catch(() => read.get(path) === data && read.delete(path))
  return data
}

/** A data file of the map page's, by its name there, as its schema makes it */
export const named = async <T,>(assets: Fetcher, name: string, schema: StandardSchemaV1<unknown, T>) => {
  const path = (await siteBuild(assets)).data[name]
  if (!path)
    throw new Error(`The map page names no ${name}`)
  return dataOf(assets, path, response => readJson(response, schema, path))
}
