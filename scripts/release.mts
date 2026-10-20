// What a build takes, published as GitHub releases by the workflows that make it (scripts/inputs.mts): the inputs,
// and the map data. Each generation of a kind is its own immutable release, <kind>-<version>, holding <kind>.tar.gz,
// every file of it with a manifest.json hashing each, and the same manifest beside it. The one mutable release,
// <kind>, holds only latest.json, uploaded last, naming the generation builds take. So a build gets all of a
// generation or none. stage() leaves those three files in a folder, which .github/actions/publish publishes

import { createReadStream } from "node:fs"
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, normalize, relative } from "node:path"
import * as v from "valibot"
import { checked } from "../src/shared/json.mts"
import { contentHash } from "../src/shared/hash.mts"
import { run } from "./files.mts"

export type Kind = "inputs" | "map-data"

const RELEASES = "https://github.com/wlib/notunh/releases/download/"

export const pointerOf = (kind: Kind) =>
  `${RELEASES}${kind}/latest.json`

export const archiveOf = (kind: Kind, version: string) =>
  `${RELEASES}${kind}-${version}/${kind}.tar.gz`

const Pointer = v.object({ version: v.string() })

/** What a generation holds, as its manifest.json says: its version, each file's SHA-256 by path, and whatever its kind adds */
export const Manifest = v.looseObject({ version: v.string(), files: v.record(v.string(), v.string()) })
export type Manifest = v.InferOutput<typeof Manifest>

/** Each file under a folder's SHA-256, by its path from there, in order of path, each read as it's hashed */
export const hashesUnder = async (folder: string) => {
  const paths = (await readdir(folder, { withFileTypes: true, recursive: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(folder, join(entry.parentPath, entry.name)))
    .sort()
  const hashes: Record<string, string> = {}
  for (const path of paths)
    hashes[path] = await contentHash(createReadStream(join(folder, path)))
  return hashes
}

/** The files of a manifest that aren't as it says, missing or with other bytes, by path */
export const mismatches = (manifest: Manifest, hashOf: (path: string) => string | undefined) =>
  Object.entries(manifest.files).flatMap(([path, hash]) => hashOf(path) === hash ? [] : [path])

/** The pointer of a kind, or null while there's no release, which only a 404 means: anything else fails */
export const fetchPointer = async (kind: Kind, load = fetch) => {
  const url = pointerOf(kind)
  const response = await load(url)
  if (response.status === 404)
    return null
  if (!response.ok)
    throw new Error(`${response.status} from ${url}`)
  return checked(Pointer, await response.json(), url)
}

/**
 * Stages the files of a folder to publish as a generation of a kind: its archive, its manifest, and the pointer to
 * upload last, in another folder. If already current, only the pointer is staged so publication can retry its hook
 * @returns whether a new generation was staged
 */
export const stage = async (kind: Kind, manifest: Manifest, folder: string, to: string, load = fetch) => {
  if ((await fetchPointer(kind, load))?.version === manifest.version) {
    await rm(to, { recursive: true, force: true })
    await mkdir(to, { recursive: true })
    await writeFile(join(to, "latest.json"), JSON.stringify({ version: manifest.version }))
    console.log(`${kind}-${manifest.version} is the generation published already`)
    return false
  }
  await rm(to, { recursive: true, force: true })
  await mkdir(to, { recursive: true })
  await writeFile(join(to, "manifest.json"), JSON.stringify(manifest))
  await run("tar", ["-czf", join(to, `${kind}.tar.gz`), "-C", folder, ".", "-C", to, "manifest.json"])
  await writeFile(join(to, "latest.json"), JSON.stringify({ version: manifest.version }))
  console.log(`Staged ${kind}-${manifest.version} in ${to}`)
  return true
}

/**
 * A generation fetched into a folder and checked against the manifest in it, which fails on any file missing or
 * different from what it says
 */
export const fetchGeneration = async (kind: Kind, version: string, folder: string, load = fetch): Promise<Manifest> => {
  const url = archiveOf(kind, version)
  const response = await load(url)
  if (!response.ok || !response.body)
    throw new Error(`${response.status} from ${url}`)
  await mkdir(folder, { recursive: true })
  await run("tar", ["-xzf", "-", "-C", folder], { input: response })
  const manifest = await checked(Manifest, JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")), url)
  if (manifest.version !== version)
    throw new Error(`${url} holds ${manifest.version}`)
  // A file that isn't there, or isn't a plain file inside the folder, has no hash, which no manifest names
  const hashes = new Map<string, string>()
  for (const path of Object.keys(manifest.files))
    if (normalize(path) === path && !isAbsolute(path) && !path.startsWith("..") && (await lstat(join(folder, path)).catch(() => undefined))?.isFile())
      hashes.set(path, await contentHash(createReadStream(join(folder, path))))
  const wrong = mismatches(manifest, path => hashes.get(path))
  if (wrong.length)
    throw new Error(`${url} isn't as its manifest says, at ${wrong.slice(0, 5).join(", ")}${wrong.length > 5 ? ` and ${wrong.length - 5} more` : ""}`)
  return manifest
}
