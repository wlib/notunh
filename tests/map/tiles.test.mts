import { test, expect } from "vitest"
import fc from "fast-check"
import { type TileSet, PROTOCOL, TILES_FOLDER, TILE_SETS, covers, extentOf, sourcesOf, tileBox, tileLoader, tileTemplate, tilesOf } from "../../src/map/tiles.mts"

const UPSTREAM = "https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf"
const VERSION = "2026-10-17"

/** A template's URL for one tile, as maplibre fills it in */
const urlOf = (template: string, z: number, x: number, y: number) =>
  template.replaceAll("{z}", `${z}`).replaceAll("{x}", `${x}`).replaceAll("{y}", `${y}`)

const tile = fc.integer({ min: 0, max: 18 }).chain(z =>
  fc.tuple(fc.constant(z), fc.nat(2 ** z - 1), fc.nat(2 ** z - 1))
)
// Tiles around Durham, where the sets are, at their zooms and either side
const nearby = fc.integer({ min: 9, max: 17 }).chain(z => {
  const [lon, lat] = [-70.93, 43.13 * Math.PI / 180]
  const [x, y] = [Math.floor((lon + 180) / 360 * 2 ** z), Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * 2 ** z)]
  const spread = Math.max(2, 2 ** (z - 10))
  return fc.tuple(fc.constant(z), fc.integer({ min: x - spread, max: x + spread }), fc.integer({ min: y - spread, max: y + spread }))
})
const someTile = fc.oneof(tile, nearby)

test("a tile's extent is its share of the world, next to its neighbors' and inside its parent's", () =>
  fc.assert(fc.property(tile, ([z, x, y]) => {
    const [west, south, east, north] = tileBox(z, x, y)
    expect(east - west).toBeCloseTo(360 / 2 ** z, 9)
    expect(north).toBeGreaterThan(south)
    expect(tileBox(z, x + 1, y)[0]).toBeCloseTo(east, 9)
    expect(tileBox(z, x, y + 1)[3]).toBeCloseTo(south, 9)
    if (z > 0) {
      const parent = tileBox(z - 1, x >> 1, y >> 1)
      expect(west).toBeGreaterThanOrEqual(parent[0] - 1e-9)
      expect(north).toBeLessThanOrEqual(parent[3] + 1e-9)
    }
  }))
)

test("a set has exactly the tiles wholly inside its boxes, at its zooms, and lists each once", () => {
  for (const set of Object.values(TILE_SETS) as TileSet[]) {
    const tiles = tilesOf(set)
    expect(new Set(tiles.map(tile => tile.join("/"))).size).toBe(tiles.length)
    const listed = new Set(tiles.map(tile => tile.join("/")))
    fc.assert(fc.property(someTile, ([z, x, y]) => {
      expect(listed.has(`${z}/${x}/${y}`)).toBe(covers(set, z, x, y))
      if (covers(set, z, x, y)) {
        const [west, south, east, north] = tileBox(z, x, y)
        expect(set.boxes.some(box => west >= box[0] && south >= box[1] && east <= box[2] && north <= box[3])).toBe(true)
        expect(z).toBeGreaterThanOrEqual(set.minzoom)
        expect(z).toBeLessThanOrEqual(set.maxzoom)
      }
    }))
    const [west, south, east, north] = extentOf(set)
    for (const box of set.boxes)
      expect(box[0] >= west && box[1] >= south && box[2] <= east && box[3] <= north).toBe(true)
  }
})

test("the base map's tiles come from here where we have them, else from upstream, and from upstream alone without ours", () =>
  fc.assert(fc.property(someTile, ([z, x, y]) => {
    const url = urlOf(tileTemplate("openmaptiles", UPSTREAM), z, x, y)
    expect(url.startsWith(`${PROTOCOL}://`)).toBe(true)
    const upstream = urlOf(UPSTREAM, z, x, y)
    expect(sourcesOf(url, VERSION)).toEqual(
      covers(TILE_SETS.openmaptiles, z, x, y) ? [`${TILES_FOLDER}${VERSION}/openmaptiles/${z}/${x}/${y}.pbf`, upstream] : [upstream]
    )
    expect(sourcesOf(url, undefined)).toEqual([upstream])
  }))
)

test("campus tiles come from here alone, and are empty anywhere else", () =>
  fc.assert(fc.property(someTile, ([z, x, y]) => {
    const url = urlOf(tileTemplate("campus"), z, x, y)
    expect(sourcesOf(url, VERSION)).toEqual(
      covers(TILE_SETS.campus, z, x, y) ? [`${TILES_FOLDER}${VERSION}/campus/${z}/${x}/${y}.pbf`] : []
    )
    expect(sourcesOf(url, undefined)).toEqual([])
  }))
)

test("the loader takes the first source that answers, passes maplibre's abort along, and is empty when none does", async () => {
  const [z, x, y] = tilesOf(TILE_SETS.openmaptiles)[0]
  const url = urlOf(tileTemplate("openmaptiles", UPSTREAM), z, x, y)
  const asked: string[] = []
  const controller = new AbortController()
  const loader = (answers: Record<string, number>) => tileLoader(VERSION, async (source, init) => {
    expect(init?.signal).toBe(controller.signal)
    asked.push(`${source}`)
    return new Response(new Uint8Array([answers[`${source}`] ?? 0]), { status: answers[`${source}`] ? 200 : 404 })
  })
  const [ours, upstream] = sourcesOf(url, VERSION)

  const bytes = async (answers: Record<string, number>, of = url) =>
    [...new Uint8Array((await loader(answers)({ url: of }, controller)).data)]
  expect(await bytes({ [ours]: 1, [upstream]: 2 })).toEqual([1])
  expect(asked).toEqual([ours])
  expect(await bytes({ [upstream]: 2 })).toEqual([2])
  expect(await bytes({})).toEqual([])
  expect(await bytes({}, urlOf(tileTemplate("campus"), 0, 0, 0))).toEqual([])

  // An abort reaches the fetch, which rejects, and so does the load
  const aborting = tileLoader(VERSION, (_, init) => new Promise((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
  ))
  const load = aborting({ url }, controller)
  controller.abort()
  await expect(load).rejects.toThrow("Aborted")
})
