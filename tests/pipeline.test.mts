import { test, expect, vi } from "vitest"
import fc from "fast-check"
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises"
import { join, relative } from "node:path"
import { tmpdir } from "node:os"
import { publishArchives } from "../scripts/archive-publish.mts"
import { runStage } from "../scripts/data.mts"
import { publish } from "../scripts/publish.mts"
import { stage, hashesUnder, fetchGeneration, stagePointer } from "../scripts/release.mts"
import { installInputBundle, validateInputs } from "../scripts/bundle.mts"
import { download, exists } from "../scripts/files.mts"
import { pathToFileURL } from "node:url"

test("a stalled learner still runs the next learner and reports failure", async () => {
  const called: string[] = []
  expect(await runStage(["map/model", "laundry/model"], [], async (_, args) => {
    called.push(args[0])
    if (called.length === 1) throw new Error("stalled")
  })).toBe(true)
  expect(called).toHaveLength(2)
})

test("a hook failure is retried even when the generation is already published", async () => {
  const folder = await mkdtemp(join(tmpdir(), "publish-test-"))
  try {
    await writeFile(join(folder, "latest.json"), '{"version":"one"}')
    const commands: string[][] = []
    const command = (...args: string[]) => { commands.push(args); return "" }
    const lookup = () => ({ assets: [{ name: "manifest.json" }] })
    await expect(publish("inputs", folder, "notes", "https://hook", command, lookup, async () => new Response(null, { status: 503 }))).rejects.toThrow("503")
    let retried = false
    await publish("inputs", folder, "notes", "https://hook", command, lookup, async () => { retried = true; return new Response() })
    expect(retried).toBe(true)
    expect(commands.every(args => args[2] === "inputs")).toBe(true)
  }
  finally { await rm(folder, { recursive: true, force: true }) }
})

test("a bundle missing a model fails before installation can use an old fixture", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bundle-test-"))
  try {
    await cp("tests/fixtures/data", folder, { recursive: true })
    await validateInputs(folder)
    await rm(join(folder, "src/laundry/usual.json"))
    await expect(validateInputs(folder)).rejects.toThrow("usual.json")
  }
  finally { await rm(folder, { recursive: true, force: true }) }
})


test("archive enumeration failure stops before publishing or cataloging", async () => {
  let published = false
  await expect(publishArchives(() => { throw new Error("Worker unavailable") }, () => { published = true; return "" })).rejects.toThrow("Worker unavailable")
  expect(published).toBe(false)
})


test("a bootstrap stall still produces both fallback models as a complete bundle", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bootstrap-test-"))
  try {
    await cp("tests/fixtures/data", folder, { recursive: true })
    for (const path of ["src/map/model.json", "src/laundry/usual.json"])
      await rm(join(folder, path))
    await writeFile(join(folder, "src/map/gtfs.zip"), "original archive")
    const failed = await runStage(["map/model", "laundry/model"], [], async (_, args) => {
      const path = args[0].includes("map/model") ? "src/map/model.json" : "src/laundry/usual.json"
      await cp(join("tests/fixtures/data", path), join(folder, path))
      if (args[0].includes("map/model")) throw new Error("learning stalled; fallback written")
    })
    expect(failed).toBe(true)
    await validateInputs(folder, true)
    await rm(join(folder, "src/map/gtfs.zip"))
    await expect(validateInputs(folder, true)).rejects.toThrow("gtfs.zip")
  }
  finally { await rm(folder, { recursive: true, force: true }) }
})


test("a downloaded production generation installs nested assets into a clean checkout", async () => {
  const folder = await mkdtemp(join(tmpdir(), "install-test-"))
  try {
    const source = join(folder, "source")
    // Relative, as the workflow names it
    const staged = relative(process.cwd(), join(folder, "staged"))
    const fetched = join(folder, "fetched")
    const target = join(folder, "checkout")
    await cp("tests/fixtures/data", source, { recursive: true })
    await writeFile(join(source, "src/map/gtfs.zip"), "original archive")
    await stage("inputs", { version: "test", files: await hashesUnder(source) }, source, staged, async () => new Response(null, { status: 404 }))
    const archive = await readFile(join(staged, "inputs.tar.gz"))
    const manifest = await fetchGeneration("inputs", "test", fetched, async () => new Response(archive))
    await installInputBundle(fetched, target, true, Object.keys(manifest.files))
    await validateInputs(target, true)
    const dining = JSON.parse(await readFile(join(target, "src/dining/menus.json"), "utf8"))
    expect(await readFile(join(target, "public", dining.files[0]), "utf8")).toBe(await readFile(join(source, "public", dining.files[0]), "utf8"))
  }
  finally { await rm(folder, { recursive: true, force: true }) }
})

test("an already published map generation stages its pointer and retries its hook", async () => {
  const folder = await mkdtemp(join(tmpdir(), "map-retry-test-"))
  try {
    await stagePointer("map-version", folder)
    let called = false
    await publish("map-data", folder, "notes", "https://hook", () => "", () => ({ assets: [{ name: "manifest.json" }] }), async () => { called = true; return new Response() })
    expect(called).toBe(true)
  }
  finally { await rm(folder, { recursive: true, force: true }) }
})

test("a download is the whole body after fewer than three failures, and after three, nothing", async () => {
  const folder = await mkdtemp(join(tmpdir(), "download-test-"))
  vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }), fc.uint8Array(), async (fails, body) => {
      const file = join(folder, "file")
      await rm(file, { force: true })
      let call = 0
      vi.stubGlobal("fetch", async () => call < fails.length && fails[call++] ? new Response("Busy", { status: 503 }) : new Response(body))
      const failsEvery = fails.length === 3 && fails.every(Boolean)
      if (failsEvery)
        await expect(download("https://example.com/file", file)).rejects.toThrow("503")
      else {
        await download("https://example.com/file", file)
        expect(new Uint8Array(await readFile(file))).toEqual(body)
      }
      expect(await exists(pathToFileURL(file))).toBe(!failsEvery)
    }), { numRuns: 30 })
  }
  finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await rm(folder, { recursive: true, force: true })
  }
})
