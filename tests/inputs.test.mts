/// <reference types="node" />
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, expect } from "vitest"
import fc from "fast-check"
import { archiveOf, fetchGeneration, pointerOf } from "../scripts/release.mts"
import { stageInputs } from "../scripts/inputs.mts"
import { run } from "../scripts/files.mts"

/** Files laid out as the repository is, by path */
const files = fc.dictionary(fc.stringMatching(/^(src\/map|public\/data)\/[a-z]{1,8}\.json$/), fc.uint8Array({ maxLength: 64 }), { minKeys: 1, maxKeys: 6 })

const folderOf = async (contents: Record<string, Uint8Array>) => {
  const folder = await mkdtemp(join(tmpdir(), "notunh-inputs-test-"))
  for (const [path, data] of Object.entries(contents)) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), data)
  }
  return folder
}

/** What GitHub serves, as releases hold it: a pointer naming a version, if any, and archives by URL */
const releases = (pointer: string | undefined, archives: Record<string, Uint8Array<ArrayBuffer>> = {}) =>
  async (input: string | URL | Request) => {
    const url = `${input}`
    if (url === pointerOf("inputs"))
      return pointer ? Response.json({ version: pointer }) : new Response(null, { status: 404 })
    return archives[url] ? new Response(archives[url]) : new Response(null, { status: 404 })
  }

/** Stages a folder as a generation of the inputs, with what it staged, or undefined if it staged nothing */
const staged = async (folder: string, pointer?: string) => {
  const to = await mkdtemp(join(tmpdir(), "notunh-staged-"))
  if (!await stageInputs(folder, to, releases(pointer)))
    return
  const manifest = JSON.parse(await readFile(join(to, "manifest.json"), "utf8"))
  expect(JSON.parse(await readFile(join(to, "latest.json"), "utf8"))).toEqual({ version: manifest.version })
  return { manifest, to, archive: new Uint8Array(await readFile(join(to, "inputs.tar.gz"))) }
}

test("inputs staged are read back exactly as they were, under a version of their day and their files, staged again only if that changes", () =>
  fc.assert(fc.asyncProperty(files, fc.nat(), async (contents, pick) => {
    const folder = await folderOf(contents)
    const { manifest, archive } = (await staged(folder))!
    expect(manifest.version).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/)
    const back = await mkdtemp(join(tmpdir(), "notunh-fetched-"))
    await fetchGeneration("inputs", manifest.version, back, releases(manifest.version, { [archiveOf("inputs", manifest.version)]: archive }))
    for (const [path, data] of Object.entries(contents))
      expect(new Uint8Array(await readFile(join(back, path)))).toEqual(data)
    // The same files are the generation published already, and one changed is another
    expect(await staged(folder, manifest.version)).toBeUndefined()
    const [path] = Object.keys(contents).slice(pick % Object.keys(contents).length)
    await writeFile(join(folder, path), new Uint8Array([...contents[path], 1]))
    expect((await staged(folder, manifest.version))!.manifest.version).not.toBe(manifest.version)
    await Promise.all([folder, back].map(path => rm(path, { recursive: true })))
  }), { numRuns: 15 }),
  30_000
)

test("a generation whose files aren't as its manifest says, or that holds another version, isn't taken", async () => {
  const folder = await folderOf({ "src/map/a.json": new Uint8Array([1]), "src/map/b.json": new Uint8Array([2]) })
  const { manifest, to } = (await staged(folder))!
  const url = archiveOf("inputs", manifest.version)
  // The same manifest beside a file changed since
  await writeFile(join(folder, "src/map/b.json"), new Uint8Array([3]))
  await run("tar", ["-czf", join(to, "changed.tar.gz"), "-C", folder, ".", "-C", to, "manifest.json"])
  const changed = new Uint8Array(await readFile(join(to, "changed.tar.gz")))
  await expect(fetchGeneration("inputs", manifest.version, await mkdtemp(join(tmpdir(), "notunh-fetched-")), releases(undefined, { [url]: changed })))
    .rejects.toThrow("isn't as its manifest says, at src/map/b.json")
  const archive = new Uint8Array(await readFile(join(to, "inputs.tar.gz")))
  await expect(fetchGeneration("inputs", manifest.version, await mkdtemp(join(tmpdir(), "notunh-fetched-")), releases(undefined, { [url]: new Uint8Array() })))
    .rejects.toThrow()
  // A manifest naming a file outside the folder it's fetched into, there with the bytes it names
  await writeFile(join(to, "manifest.json"), JSON.stringify({ ...manifest, files: { "../outside.json": manifest.files["src/map/a.json"] } }))
  await writeFile(join(folder, "outside.json"), new Uint8Array([1]))
  await run("tar", ["-czf", join(to, "outside.tar.gz"), "-C", folder, ".", "-C", to, "manifest.json"])
  await expect(fetchGeneration("inputs", manifest.version, join(folder, "fetched"), releases(undefined, { [url]: new Uint8Array(await readFile(join(to, "outside.tar.gz"))) })))
    .rejects.toThrow("isn't as its manifest says, at ../outside.json")
  await expect(fetchGeneration("inputs", "2026-01-01-00000000", await mkdtemp(join(tmpdir(), "notunh-fetched-")), releases(undefined, { [archiveOf("inputs", "2026-01-01-00000000")]: archive })))
    .rejects.toThrow(`holds ${manifest.version}`)
})
