// What build steps ask of the files they write, the files the site serves fetched back to stay published, and the
// fixtures that stand in for upstream when there's no network

import { access, cp, mkdir, writeFile } from "node:fs/promises"
// Node's own, which its file functions take, whatever the global one is where this is checked
import { URL } from "node:url"
import { ORIGIN } from "./site.mts"

/** The build's public folder, served as it is */
export const PUBLIC = new URL("../public/", import.meta.url)

export const exists = (url: URL) =>
  access(url).then(() => true, () => false)

/** Whether a file a build step writes is already there and asked to be kept, with --if-missing */
export const isKept = async (output: URL) =>
  process.argv.includes("--if-missing") && await exists(output)

/**
 * Files the site serves now, by URL, fetched back into the public folder, so what's published stays published one
 * more build for the pages still open on it, as a build starts from nothing: those kept, with a warning for each
 * that couldn't be
 */
export const keepServed = async (urls: readonly string[]) =>
  (await Promise.all(urls.map(url =>
    fetch(ORIGIN + url)
      .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${response.status}`)))
      .then(async body => {
        const file = new URL(`.${decodeURIComponent(url)}`, PUBLIC)
        await mkdir(new URL(".", file), { recursive: true })
        await writeFile(file, new Uint8Array(body))
        return url
      })
      .catch(error => void console.warn(`Not keeping ${url}: ${error.message}`))
  ))).filter((url): url is string => url !== undefined)

/**
 * A build with NOTUNH_OFFLINE set, as pull requests are checked, which fetches nothing: every data file comes from
 * the fixtures, and nothing is learned
 */
export const isOffline = Boolean(process.env.NOTUNH_OFFLINE)

/** Small, real-shaped copies of every data file, laid out as the repository is, made by tests/fixtures/make.mts */
export const FIXTURES = new URL("../tests/fixtures/data/", import.meta.url)

/** Copies a fixture, a file or a whole folder, by its path in the repository, to where the real one goes */
export const fromFixtures = (path: string) =>
  cp(new URL(path, FIXTURES), new URL(`../${path}`, import.meta.url), { recursive: true })
