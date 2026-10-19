import { test, expect, vi } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { createExpression, featureFilter, validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import type { FilterSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl"
import { BASE, CAMPUS, GLYPH_RANGES, fontsOf, glyphsFrom, hostedAt, loadStyle, restyle, upstreamGlyphs } from "../../src/map/style.mts"
import { pathsOf } from "../../scripts/map/style.mts"
import { TILE_SETS, tileTemplate } from "../../src/map/tiles.mts"

// Liberty as OpenFreeMap served it in October 2026
const liberty: StyleSpecification = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/liberty.json.gz", import.meta.url))).toString())
const TILES = {
  tiles: ["https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf"],
  minzoom: 0,
  maxzoom: 14,
  attribution: "<a href=\"https://openfreemap.org\">OpenFreeMap</a>"
}
// Where the build put this style, named by a hash of it
const FOLDER = "/data/map/AAAAAAAAAAAAAAAA/"
const style = restyle(liberty, TILES, FOLDER)
const layer = (id: string) => style.layers.find(layer => layer.id === id)!
const libertyLayer = (id: string) => liberty.layers.find(layer => layer.id === id)!

const CAMPUS_LAYERS = ["campus_parking", "campus_barrier", "campus_tree", "campus_entrance", "campus_amenity", "campus_building"]
const ADDED = ["landuse_university", "landuse_stadium", "landuse_playground", "landuse_retail", "road_platform_area", "road_platform", "housenumber", ...CAMPUS_LAYERS]

test("the style is valid, with every one of Liberty's layers in its order, and only ours added", () => {
  expect(validateStyleMin(style)).toEqual([])
  const ids = style.layers.map(layer => layer.id)
  expect(ids.filter(id => !ADDED.includes(id))).toEqual(liberty.layers.map(layer => layer.id))
  expect(ids.filter(id => ADDED.includes(id)).sort()).toEqual([...ADDED].sort())
  // Campuses beneath the woods and grass on them, and house numbers above the buildings
  expect(ids.indexOf("landuse_university")).toBeLessThan(ids.indexOf("landcover_wood"))
  expect(ids.indexOf("housenumber")).toBeGreaterThan(ids.indexOf("building-3d"))
})

test("tiles are ours where we have them, else from one planet build, and the sprite and fonts from the style's own folder on our origin", () => {
  expect(style.sources[BASE]).toEqual({ type: "vector", ...TILES, tiles: TILES.tiles.map(upstream => tileTemplate(BASE, upstream)) })
  expect(style.sources[CAMPUS]).toEqual({ type: "vector", tiles: [tileTemplate(CAMPUS)], minzoom: TILE_SETS.campus.minzoom, maxzoom: TILE_SETS.campus.maxzoom })
  expect(style.sprite).toBe(`${FOLDER}sprite`)
  expect(style.glyphs).toBe(`${FOLDER}fonts/{fontstack}/{range}.pbf`)
  expect(upstreamGlyphs(style)).toBe(liberty.glyphs)
  expect(fontsOf(style).sort()).toEqual(["Noto Sans Bold", "Noto Sans Italic", "Noto Sans Regular"])
  // Which, with the style and sprite, is every file of the folder, as the build writes it and as a later one fetches it back
  expect(pathsOf(fontsOf(style))).toEqual([
    "style.json", "sprite.json", "sprite.png", "sprite@2x.json", "sprite@2x.png",
    ...fontsOf(style).flatMap(font => GLYPH_RANGES.map(range => `fonts/${encodeURIComponent(font)}/${range}.pbf`))
  ])

  const hosted = hostedAt(style, "https://notunh.app")
  expect(hosted.sprite).toBe(`https://notunh.app${FOLDER}sprite`)
  expect(hosted.glyphs).toBe(`https://notunh.app${FOLDER}fonts/{fontstack}/{range}.pbf`)
  // The folder's name is all that differs between two builds of the same style, so a hash of it taken without the
  // folder names the folder
  expect(JSON.stringify(restyle(liberty, TILES, "/data/map/BBBBBBBBBBBBBBBB/")).replaceAll("BBBBBBBBBBBBBBBB", "AAAAAAAAAAAAAAAA")).toBe(JSON.stringify(style))
})

const RANGE = fc.nat({ max: 255 }).map(i => `${i * 256}-${i * 256 + 255}`)
const FONT = fc.constantFrom("Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic")

test("glyphs come from here in the ranges kept here, and from upstream in any other", () => {
  const upstream = upstreamGlyphs(style)!
  fc.assert(fc.property(FONT, RANGE, (font, range) => {
    const url = `https://notunh.app${FOLDER}fonts/${font}/${range}.pbf`
    expect(glyphsFrom(url, upstream)).toBe(
      GLYPH_RANGES.includes(range) ? url : upstream.replace("{fontstack}", font).replace("{range}", range)
    )
    expect(glyphsFrom(url, undefined)).toBe(url)
  }))
})

type Feature = { type: 1 | 2 | 3, properties: Record<string, string | number> }

const passes = (layer: LayerSpecification, feature: Feature, zoom = 18) =>
  !("filter" in layer && layer.filter) ||
  featureFilter(layer.filter as FilterSpecification, "filter").filter({ zoom }, { ...feature, geometry: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }]] } as any)

const iconOf = (layer: LayerSpecification, feature: Feature) => {
  const icon = layer.type === "symbol" ? layer.layout?.["icon-image"] : undefined
  const expression = createExpression(icon, "icon-image")
  if (expression.result !== "success")
    throw new Error(JSON.stringify(expression.value))
  return expression.value.evaluate({ zoom: 18 }, feature as any)
}

const POI_LAYERS = ["poi_r1", "poi_r7", "poi_r20", "poi_transit"]
const poi = fc.record({
  class: fc.constantFrom(
    "bicycle_parking", "atm", "recycling", "bollard", "gate", "lift_gate", "garden", "bus", "rail", "cafe", "swimming_pool",
    "sports_centre", "office", "parking"
  ),
  subclass: fc.constantFrom("bus_stop", "bus_station", "station", "garden", "florist", "other"),
  rank: fc.integer({ min: 1, max: 120 })
}).chain(properties => fc.option(fc.constantFrom("Thompson Hall", "Durham"), { nil: undefined })
  .map((name): Feature => ({ type: 1, properties: name ? { ...properties, name } : properties }))
)

test("points of interest are as Liberty draws them, but for barriers, bus stops, and unnamed flowerbeds", () => {
  fc.assert(fc.property(poi, feature => {
    const { class: kind, subclass, name } = feature.properties
    const isHidden =
      ["bollard", "gate", "lift_gate"].includes(kind as string) ||
      subclass === "bus_stop" ||
      kind === "garden" && !name
    for (const id of POI_LAYERS)
      expect(passes(layer(id), feature)).toBe(!isHidden && passes(libertyLayer(id), feature))
  }))
})

test("points of interest without a sprite icon are drawn with ours, or a close one, and the rest as before", () => {
  const ALIASES: Record<string, string> = { swimming_pool: "swimming", sports_centre: "stadium" }
  fc.assert(fc.property(poi, feature => {
    for (const id of ["poi_r1", "poi_r7", "poi_r20"])
      expect(iconOf(layer(id), feature)?.toString()).toBe(
        ALIASES[feature.properties.class] ?? iconOf(libertyLayer(id), feature)?.toString()
      )
  }))
  expect(iconOf(layer("poi_r20"), { type: 1, properties: { class: "bicycle_parking", subclass: "bicycle_parking" } }).toString())
    .toBe("bicycle_parking")
})

test("platforms are drawn as platforms rather than as footpaths, and other paths as before", () => {
  fc.assert(fc.property(
    fc.constantFrom<1 | 2 | 3>(2, 3),
    fc.constantFrom("platform", "footway", "path", "pedestrian"),
    (type, subclass) => {
      const feature = { type, properties: { class: "path", subclass } }
      const isPlatform = subclass === "platform"
      expect(passes(layer("road_platform"), feature)).toBe(isPlatform && type === 2)
      expect(passes(layer("road_platform_area"), feature)).toBe(isPlatform && type === 3)
      for (const id of ["road_path_pedestrian", "road_area_pattern"])
        expect(passes(layer(id), feature)).toBe(!isPlatform && passes(libertyLayer(id), feature))
    }
  ))
})

test("campus land use, stadiums, playgrounds, and shops are filled, and house numbers are drawn close up", () => {
  for (const [kind, id] of [["university", "landuse_university"], ["college", "landuse_university"], ["stadium", "landuse_stadium"], ["playground", "landuse_playground"], ["retail", "landuse_retail"]])
    expect(passes(layer(id), { type: 3, properties: { class: kind } })).toBe(true)
  expect(layer("housenumber")).toMatchObject({ "source-layer": "housenumber", minzoom: 17 })
})

// The layers of our campus tiles, as scripts/map/campus.yml makes them
const CAMPUS_TILES = {
  parking:  { type: 3, properties: { access: "private" } },
  barrier:  { type: 2, properties: { kind: "fence" } },
  tree:     { type: 1, properties: {} },
  entrance: { type: 1, properties: { kind: "main" } },
  amenity:  { type: 1, properties: { kind: "phone" } },
  building: { type: 1, properties: { name: "Thompson Hall" } }
} satisfies Record<string, Feature>

test("campus details are drawn from our tiles, each from the zoom there's room for it, and between Liberty's own", () => {
  const ids = style.layers.map(layer => layer.id)
  for (const [sourceLayer, feature] of Object.entries(CAMPUS_TILES)) {
    const drawn = layer(`campus_${sourceLayer}`)
    expect(drawn).toMatchObject({ source: CAMPUS, "source-layer": sourceLayer })
    expect(passes(drawn, feature)).toBe(true)
    // Never asked for before the tiles have it
    expect(drawn.minzoom).toBeGreaterThanOrEqual(TILE_SETS.campus.minzoom)
  }
  expect(Object.fromEntries(CAMPUS_LAYERS.map(id => [id, layer(id).minzoom]))).toEqual({
    campus_parking: 14, campus_barrier: 16, campus_tree: 17, campus_entrance: 17, campus_amenity: 18, campus_building: 16
  })
  // Parking lots over the grass and beneath the roads, fences and trees beneath the buildings, and doors, benches, and
  // building names above them, but beneath Liberty's points of interest and their names
  expect(ids.indexOf("campus_parking")).toBeGreaterThan(ids.indexOf("landcover_grass"))
  expect(ids.indexOf("campus_parking")).toBeLessThan(ids.indexOf("road_minor"))
  for (const id of ["campus_barrier", "campus_tree"])
    expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("building"))
  for (const id of ["campus_entrance", "campus_amenity", "campus_building"]) {
    expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("building-3d"))
    expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("poi_r20"))
  }
  expect(fontsOf(style)).toContain("Noto Sans Regular")
})

test("the style is loaded with its manifest, so one that can't be had fails the load, to be tried again past the caches, rather than wanted by the map and never come", async () => {
  const manifest = { url: `${FOLDER}style.json`, required: [`${FOLDER}style.json`], folders: [FOLDER] }
  const answers = new Map<string, unknown>([["/assets/style-AAAAAAAA.json", manifest]])
  const asked: [string, RequestCache | undefined][] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push([url, init.cache])
    return answers.has(url) ? Response.json(answers.get(url)) : new Response("Not found", { status: 404 })
  })
  try {
    await expect(loadStyle("/assets/style-AAAAAAAA.json", { cache: "default" })).rejects.toThrow(`404 from ${manifest.url}`)
    answers.set(manifest.url, style)
    expect(await loadStyle("/assets/style-AAAAAAAA.json", { cache: "reload" })).toEqual({ ...manifest, style })
    expect(asked.slice(-2)).toEqual([["/assets/style-AAAAAAAA.json", "reload"], [manifest.url, "reload"]])
  }
  finally {
    vi.unstubAllGlobals()
  }
})
