// File helpers for the scripts: the inputs being made, fetching back what the site serves so it stays published, the
// fixtures that stand in for upstream when there's no network, and running other commands

import { type SpawnOptions, spawn } from "node:child_process"
import { access, mkdir, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
// Node's URL, which its fs functions take, rather than whatever global URL the typecheck sees
import { URL } from "node:url"
import { ORIGIN } from "./site.mts"

/** The repository, which the inputs and the fixtures are laid out as */
export const REPO = new URL("../", import.meta.url)

/** The build's public folder, served as it is */
export const PUBLIC = new URL("public/", REPO)

/** Where the inputs are made, laid out as the repository is, until published or installed (scripts/inputs.mts) */
export const STAGED = new URL("inputs/", REPO)

export const exists = (url: URL) =>
  access(url).then(() => true, () => false)

/** Writes a file of the inputs being made, by its path in the repository, or anywhere by its URL */
export const writeInput = async (path: string | URL, data: string | Uint8Array) => {
  const file = new URL(path, STAGED)
  await mkdir(new URL(".", file), { recursive: true })
  await writeFile(file, data)
}

/**
 * Files the site serves now, by URL, fetched back into the public folder. A build starts from nothing, so this keeps
 * what's published for one more build, for the pages still open on it. Gives back those kept, warning for each that
 * couldn't be
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
 * the fixtures
 */
export const isOffline = Boolean(process.env.NOTUNH_OFFLINE)

/** Small, real-shaped copies of every data file, laid out as the repository is, made by tests/fixtures/make.mts */
export const FIXTURES = new URL("tests/fixtures/data/", REPO)

/** Runs a command to its end, showing its output, with a response's body piped in if given; fails if it does */
export const run = (command: string, args: string[], { input, ...options }: SpawnOptions & { input?: Response } = {}) =>
  new Promise<void>((done, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "inherit", "inherit"], ...options })
    child.on("error", reject).on("exit", code => code === 0 ? done() : reject(new Error(`${[command, ...args].join(" ")} exited with ${code}`)))
    if (input)
      pipeline(Readable.fromWeb(input.body as any), child.stdin!).catch(reject)
  })
