import { test, expect } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { POINTER, fetchPointer, lockedClosure, manifestOf, mismatches } from "../../scripts/map/release.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { walkGraph } from "../../scripts/map/walkable.mts"
import { gazetteerOf } from "../../scripts/map/gazetteer.mts"
import type { OsmElement } from "../../scripts/map/pbf.mts"
import { type Made, versionOf } from "../../src/shared/made.mts"
import type { WalkData } from "../../src/routing/graph.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { FIXTURES } from "../../scripts/files.mts"

const MADE: Made = { extract: "2026-10-13", generator: "3fa880d87b44b360178b9552605ea6da9d004d6ea7662cff696aa156b0b5e3eb" }

const files = fc.dictionary(fc.stringMatching(/^(tiles\/\w+\/\d+\/\d+\/\d+\.pbf|\w+\.json)$/), fc.uint8Array({ maxLength: 64 }), { minKeys: 1, maxKeys: 8 })

test("a generation's version is its extract and the start of its generator, so new code on the same extract is a new one", () => {
  expect(versionOf(MADE)).toBe("2026-10-13-3fa880d8")
  expect(versionOf({ ...MADE, generator: "4" + MADE.generator.slice(1) })).not.toBe(versionOf(MADE))
})

test("the generator's packages are as package-lock.json resolves them, with all they depend on, nested installs before those above", () => {
  const packages = {
    "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
    "node_modules/a": { version: "1.0.0", integrity: "sha512-a", dependencies: { c: "^2.0.0", d: "^1.0.0" } },
    "node_modules/a/node_modules/c": { version: "2.0.0", integrity: "sha512-c2" },
    "node_modules/b": { version: "1.0.0", integrity: "sha512-b" },
    "node_modules/c": { version: "1.0.0", integrity: "sha512-c1" },
    "node_modules/d": { version: "1.1.0", integrity: "sha512-d", dependencies: { c: "^1.0.0" } }
  }
  expect(lockedClosure(packages, ["a"])).toEqual([
    "node_modules/a 1.0.0 sha512-a",
    "node_modules/a/node_modules/c 2.0.0 sha512-c2",
    "node_modules/c 1.0.0 sha512-c1",
    "node_modules/d 1.1.0 sha512-d"
  ])
  // A dependency's own update changes what's hashed, though the package named didn't change
  expect(lockedClosure({ ...packages, "node_modules/d": { ...packages["node_modules/d"], version: "1.2.0" } }, ["a"])).not.toEqual(lockedClosure(packages, ["a"]))
  expect(() => lockedClosure(packages, ["e"])).toThrow("isn't in package-lock.json")
})

test("an archive is as its manifest says only when every file it names has exactly those bytes", () =>
  fc.assert(fc.asyncProperty(files, fc.nat(), fc.nat(), async (contents, pick, flip) => {
    const manifest = await manifestOf(MADE, Object.fromEntries(Object.entries(contents).map(([path, data]) => [path, () => data])))
    expect(manifest).toMatchObject({ ...MADE, version: versionOf(MADE) })
    expect(Object.keys(manifest.files).sort()).toEqual(Object.keys(contents).sort())
    const hashOf = async (found: Record<string, Uint8Array>) => {
      const hashes = new Map(await Promise.all(Object.entries(found).map(async ([path, data]) => [path, await contentHash(data)] as const)))
      return (path: string) => hashes.get(path)
    }
    expect(mismatches(manifest, await hashOf(contents))).toEqual([])
    // Files beyond the manifest's don't matter; one missing or changed does
    expect(mismatches(manifest, await hashOf({ ...contents, extra: new Uint8Array() }))).toEqual([])
    const [path] = Object.keys(contents).slice(pick % Object.keys(contents).length)
    const { [path]: data, ...without } = contents
    expect(mismatches(manifest, await hashOf(without))).toEqual([path])
    const changed = new Uint8Array([...data, flip % 256])
    expect(mismatches(manifest, await hashOf({ ...contents, [path]: changed }))).toEqual([path])
  }))
)

test("only a 404 of the pointer means no release yet; any other failure fails the build, and a pointer must name a version", async () => {
  const answering = (status: number, body?: unknown) => async (url: string | URL | Request) => {
    expect(url).toBe(POINTER)
    return body === undefined ? new Response(null, { status }) : Response.json(body, { status })
  }
  expect(await fetchPointer(answering(404))).toBeNull()
  expect(await fetchPointer(answering(200, { version: "2026-10-13-3fa880d8" }))).toEqual({ version: "2026-10-13-3fa880d8" })
  for (const status of [500, 502, 403, 301])
    await expect(fetchPointer(answering(status))).rejects.toThrow(`${status}`)
  await expect(fetchPointer(answering(200, {}))).rejects.toThrow("version")
  await expect(fetchPointer(async () => { throw new TypeError("fetch failed") })).rejects.toThrow("fetch failed")
})

// The fallbacks while there's no release, which must be what the generator would make today
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(new URL(`src/map/${name}.json`, FIXTURES), "utf8"))

test("the walk and gazetteer fallbacks carry where they came from, together, and are shaped as the generator shapes them", () => {
  const walk = fixture<{ made: Made } & WalkData>("walk")
  const gazetteer = fixture<Gazetteer>("gazetteer")
  expect(walk.made).toEqual(gazetteer.made)
  expect(walk.made).toMatchObject({ extract: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), generator: expect.stringMatching(/^[0-9a-f]{64}$/) })
  expect(Object.keys(walk)).toEqual(["made", ...Object.keys(walkGraph([]))])
  expect(walk.vertices.length).toBeGreaterThan(2000)

  const outline = [[-70.931, 43.134], [-70.929, 43.134], [-70.929, 43.136], [-70.931, 43.136]].map(([lon, lat]) => ({ lat, lon }))
  const elements: OsmElement[] = [
    { type: "way", id: 1, nodes: [11, 12, 13, 14, 11], tags: { building: "university", name: "Kingsbury Hall" }, geometry: [...outline, outline[0]], bounds: [-70.931, 43.134, -70.929, 43.136] },
    { type: "node", id: 11, ...outline[0], tags: { entrance: "main" } },
    { type: "node", id: 20, lat: 43.135, lon: -70.93, tags: { amenity: "cafe", name: "Zeke's" } }
  ]
  const generated = new Set(gazetteerOf(elements).flatMap(place => Object.keys(place)))
  expect(Object.keys(gazetteer)).toEqual(["made", "places"])
  expect(gazetteer.places.length).toBeGreaterThan(100)
  for (const place of gazetteer.places)
    for (const key of Object.keys(place))
      expect(generated).toContain(key)
})
