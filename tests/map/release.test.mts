import { test, expect } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { POINTER, fetchPointer, manifestOf, mismatches, sha256 } from "../../scripts/map/release.mts"
import { walkGraph } from "../../scripts/map/walkable.mts"
import { gazetteerOf } from "../../scripts/map/gazetteer.mts"
import type { OsmElement } from "../../scripts/map/pbf.mts"
import { type Made, versionOf } from "../../src/map/made.mts"
import type { WalkData } from "../../src/map/graph.mts"
import type { Gazetteer } from "../../src/map/gazetteer.mts"
import { FIXTURES } from "../../scripts/files.mts"

const MADE: Made = { extract: "2026-10-13", generator: "3fa880d87b44b360178b9552605ea6da9d004d6ea7662cff696aa156b0b5e3eb" }

const files = fc.dictionary(fc.stringMatching(/^(tiles\/\w+\/\d+\/\d+\/\d+\.pbf|\w+\.json)$/), fc.uint8Array({ maxLength: 64 }), { minKeys: 1, maxKeys: 8 })

test("a generation's version is its extract and the start of its generator, so new code on the same extract is a new one", () => {
  expect(versionOf(MADE)).toBe("2026-10-13-3fa880d8")
  expect(versionOf({ ...MADE, generator: "4" + MADE.generator.slice(1) })).not.toBe(versionOf(MADE))
})

test("an archive is as its manifest says only when every file it names has exactly those bytes", () =>
  fc.assert(fc.property(files, fc.nat(), fc.nat(), (contents, pick, flip) => {
    const manifest = manifestOf(MADE, contents)
    expect(manifest).toMatchObject({ ...MADE, version: versionOf(MADE) })
    expect(Object.keys(manifest.files).sort()).toEqual(Object.keys(contents).sort())
    const hashOf = (found: Record<string, Uint8Array>) => (path: string) => path in found ? sha256(found[path]) : undefined
    expect(mismatches(manifest, hashOf(contents))).toEqual([])
    // Files beyond the manifest's don't matter; one missing or changed does
    expect(mismatches(manifest, hashOf({ ...contents, extra: new Uint8Array() }))).toEqual([])
    const [path] = Object.keys(contents).slice(pick % Object.keys(contents).length)
    const { [path]: data, ...without } = contents
    expect(mismatches(manifest, hashOf(without))).toEqual([path])
    const changed = new Uint8Array([...data, flip % 256])
    expect(mismatches(manifest, hashOf({ ...contents, [path]: changed }))).toEqual([path])
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
