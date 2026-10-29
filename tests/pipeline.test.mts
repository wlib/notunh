import { test, expect, vi } from "vitest"
import fc from "fast-check"
import { readFile, writeFile, rm, cp } from "node:fs/promises"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { publishArchives } from "../scripts/archive-publish.mts"
import { runStage } from "../scripts/data.mts"
import { publish } from "../scripts/publish.mts"
import { stage, hashesUnder, fetchGeneration, stagePointer } from "../scripts/release.mts"
import { installInputBundle, validateInputs } from "../scripts/bundle.mts"
import { download, exists } from "../scripts/files.mts"
import { dataCopy, dataFile, tempFolder } from "./fixtures/temp.mts"

/** A release lookup finding a generation already published, by its manifest */
const published = () => ({ assets: [{ name: "manifest.json" }] })

test("a hook that fails is tried again on the next publish, of the inputs' generation already published and of the map's, whose pointer is staged", async () => {
  const inputs = await tempFolder()
  await writeFile(join(inputs, "latest.json"), '{"version":"one"}')
  const commands: string[][] = []
  const command = (...args: string[]) => { commands.push(args); return "" }
  await expect(publish("inputs", inputs, "notes", "https://hook", command, published, async () => new Response(null, { status: 503 }))).rejects.toThrow("503")
  let retried = false
  await publish("inputs", inputs, "notes", "https://hook", command, published, async () => { retried = true; return new Response() })
  expect(retried).toBe(true)
  expect(commands.every(args => args[2] === "inputs")).toBe(true)

  const map = await tempFolder()
  await stagePointer("map-version", map)
  let called = false
  await publish("map-data", map, "notes", "https://hook", () => "", published, async () => { called = true; return new Response() })
  expect(called).toBe(true)
})

test("a bundle missing a model fails before installation can use an old fixture", async () => {
  const folder = await dataCopy()
  await validateInputs(folder)
  await rm(join(folder, "src/laundry/usual.json"))
  await expect(validateInputs(folder)).rejects.toThrow("usual.json")
})

test("a generation may lack what came later, but what it has must name only files it has", async () => {
  const folder = await dataCopy()
  const courses = JSON.parse(await readFile(join(folder, "src/courses/courses.json"), "utf8"))
  await rm(join(folder, "public", courses.files[0]))
  await expect(validateInputs(folder)).rejects.toThrow(courses.files[0])
  for (const path of ["src/courses/courses.json", "src/programs/prereqs.json", "src/parking/parking.json", "src/map/events.json"])
    await rm(join(folder, path))
  await validateInputs(folder)
})

test("archive enumeration failure stops before publishing or cataloging", async () => {
  let published = false
  await expect(publishArchives(() => { throw new Error("Worker unavailable") }, () => { published = true; return "" })).rejects.toThrow("Worker unavailable")
  expect(published).toBe(false)
})

test("a learner that stalls still lets the next run, and the fallback models both wrote are a whole bundle, reported as failed", async () => {
  const folder = await dataCopy()
  for (const path of ["src/map/model.json", "src/laundry/usual.json"])
    await rm(join(folder, path))
  await writeFile(join(folder, "src/map/gtfs.zip"), "original archive")
  const called: string[] = []
  const failed = await runStage(["map/model", "laundry/model"], [], async (_, args) => {
    called.push(args[0])
    const path = args[0].includes("map/model") ? "src/map/model.json" : "src/laundry/usual.json"
    await cp(dataFile(path), join(folder, path))
    if (args[0].includes("map/model")) throw new Error("learning stalled; fallback written")
  })
  expect(failed).toBe(true)
  expect(called).toHaveLength(2)
  await validateInputs(folder, true)
  await rm(join(folder, "src/map/gtfs.zip"))
  await expect(validateInputs(folder, true)).rejects.toThrow("gtfs.zip")
})

test("a downloaded production generation installs nested assets into a clean checkout", async () => {
  const folder = await tempFolder()
  const source = join(folder, "source")
  // Relative, as the workflow names it
  const staged = relative(process.cwd(), join(folder, "staged"))
  const fetched = join(folder, "fetched")
  const target = join(folder, "checkout")
  await cp(dataFile(""), source, { recursive: true })
  await writeFile(join(source, "src/map/gtfs.zip"), "original archive")
  await stage("inputs", { version: "test", files: await hashesUnder(source) }, source, staged, async () => new Response(null, { status: 404 }))
  const archive = await readFile(join(staged, "inputs.tar.gz"))
  const manifest = await fetchGeneration("inputs", "test", fetched, async () => new Response(archive))
  await installInputBundle(fetched, target, true, Object.keys(manifest.files))
  await validateInputs(target, true)
  const dining = JSON.parse(await readFile(join(target, "src/dining/menus.json"), "utf8"))
  expect(await readFile(join(target, "public", dining.files[0]), "utf8")).toBe(await readFile(join(source, "public", dining.files[0]), "utf8"))
})

test("a download is the whole body after fewer than three failures, and after three, nothing", async () => {
  const folder = await tempFolder()
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
  }
})
