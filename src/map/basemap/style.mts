// OpenFreeMap's Liberty style, made ours. It's served from our own origin with its sprite and the fonts our labels
// need. Its tiles are ours where we have them, else pinned to one planet build. It's redrawn where it hides what's
// already in the tiles, and draws our campus tiles too. The build (scripts/map/style.mts) writes it all into one folder
// named by a hash of it, so the style, sprite, and fonts the map loads always match. It names the folder in a
// manifest the page bundles, which the map loads the style by

import type { FilterSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl"
import * as v from "valibot"
import { TILE_SETS, tileTemplate } from "./tiles.mts"
import { Retain } from "../../shell/manifest.mts"
import { getJson, objectOf, readJson } from "../../shared/json.mts"

export const LIBERTY = "https://tiles.openfreemap.org/styles/liberty"
/** Where each style's folder is, beside the tiles' */
export const STYLE_ROOT = "/data/map/"

/**
 * What the map's page names as its style: where the style is, which the page requires, and the folder to keep with it
 */
export const StyleManifest = v.object({ ...Retain.entries, url: v.string() })
export type StyleManifest = v.InferOutput<typeof StyleManifest>

/** The manifest with the style it names, which the map applies as it is, so it never wants a style it doesn't have */
export type LoadedStyle = StyleManifest & { style: StyleSpecification }

/**
 * The manifest and its style, loaded as one. A style that can't be had is then a failed load of the manifest, retried
 * like any other (src/shell/build.mts), rather than a style the map waits on forever
 */
export const loadStyle = async (response: Response, init: RequestInit): Promise<LoadedStyle> => {
  const manifest = await readJson(response, StyleManifest)
  return { ...manifest, style: await getJson(manifest.url, { ...init, schema: objectOf<StyleSpecification>() }) }
}
// Liberty's vector tiles, and ours of what they leave out
export const BASE = "openmaptiles"
export const CAMPUS = "campus"

/** The glyph ranges kept here: Latin, the rest of Latin, and punctuation like ’ and –, all that Durham's names use */
export const GLYPH_RANGES = ["0-255", "256-511", "8192-8447"]

/** What a TileJSON says of its tiles */
export type TileJson = {
  tiles:        string[],
  minzoom?:     number,
  maxzoom?:     number,
  attribution?: string
}

// Barriers and bus stops, which our own stops already show, and unnamed flowerbeds, which are everywhere on campus
const HIDDEN_POI: FilterSpecification = ["any",
  ["match", ["get", "class"], ["bollard", "gate", "lift_gate"], true, false],
  ["==", ["get", "subclass"], "bus_stop"],
  ["all", ["==", ["get", "class"], "garden"], ["!", ["has", "name"]]]
]

/** Points of interest Liberty's sprite has no icon for, which the map draws itself, by name */
export const DRAWN_ICONS = ["bicycle_parking", "atm", "recycling"] as const

// Others drawn with a sprite icon close enough
const ICON_ALIASES: Record<string, string> = {
  swimming_pool: "swimming",
  sports_centre: "stadium"
}

// Platforms, which Liberty draws as footpaths
const PLATFORM: FilterSpecification = ["==", ["get", "subclass"], "platform"]
const AREA: FilterSpecification = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false]

const RAIL = "#999"
const PITCH = "#d3e3c3"

const isRail = (id: string) => /^(road|bridge)_major_rail/.test(id)
const isPoi = (layer: LayerSpecification) =>
  layer.type === "symbol" && layer["source-layer"] === "poi"

/** A layer without the features a filter matches */
const without = (layer: LayerSpecification, filter: FilterSpecification): LayerSpecification =>
  ({ ...layer, filter: "filter" in layer && layer.filter ? ["all", layer.filter, ["!", filter]] : ["!", filter] } as LayerSpecification)

const landuse = (id: string, classes: string[], color: string): LayerSpecification => ({
  id,
  type: "fill",
  source: BASE,
  "source-layer": "landuse",
  filter: ["match", ["get", "class"], classes, true, false],
  paint: { "fill-color": color }
})

const campus = (id: string, type: "fill" | "line" | "circle" | "symbol", minzoom: number, rest: object) =>
  ({ id: `campus_${id}`, type, source: CAMPUS, "source-layer": id, minzoom, ...rest } as LayerSpecification)

/** A dot drawn bigger closer in */
const dot = (color: string, from: number, to: number, stroke = "white") => ({
  "circle-color": color,
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 17, from, 20, to],
  "circle-stroke-color": stroke,
  "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 17, 0.5, 20, 1]
})

/** Layers Liberty lacks, each put after the layer named */
const ADDED: Record<string, LayerSpecification[]> = {
  // Beneath the grass and woods on them, as campuses and stadiums are mostly made of other things
  landuse_residential: [
    landuse("landuse_university", ["university", "college"], "hsl(52, 40%, 92%)"),
    landuse("landuse_stadium", ["stadium"], "hsl(100, 30%, 88%)"),
    landuse("landuse_playground", ["playground"], "hsl(150, 40%, 88%)"),
    landuse("landuse_retail", ["retail"], "hsl(5, 45%, 93%)")
  ],
  // Over the grass and beneath the roads, as their aisles are service roads
  landuse_school: [
    campus("parking", "fill", 14, {
      paint: {
        "fill-color": "hsl(220, 12%, 92%)",
        "fill-outline-color": ["interpolate", ["linear"], ["zoom"], 14, "hsla(220, 8%, 80%, 0)", 16, "hsl(220, 8%, 80%)"]
      }
    })
  ],
  // Beneath the buildings, as fences and walls meet them
  bridge_transit_rail_hatching: [
    campus("barrier", "line", 16, {
      paint: {
        "line-color": ["match", ["get", "kind"], "hedge", "hsl(100, 25%, 68%)", "hsl(30, 6%, 68%)"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 16, 0.5, 20, ["match", ["get", "kind"], "hedge", 4, 1.5]]
      }
    }),
    campus("tree", "circle", 17, { paint: dot("hsla(110, 35%, 55%, 0.45)", 2, 9, "transparent") })
  ],
  // Under the roads, as platforms are where they meet the rails
  road_area_pattern: [
    {
      id: "road_platform_area",
      type: "fill",
      source: BASE,
      "source-layer": "transportation",
      minzoom: 14,
      filter: ["all", PLATFORM, AREA],
      paint: { "fill-color": "#d6d3cf", "fill-outline-color": "#a9a6a2" }
    },
    {
      id: "road_platform",
      type: "line",
      source: BASE,
      "source-layer": "transportation",
      minzoom: 14,
      filter: ["all", PLATFORM, ["!", AREA]],
      paint: {
        "line-color": "#d6d3cf",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 14, 1.5, 16, 4, 20, 20]
      }
    }
  ],
  // Above the buildings, quietly, from where there's room
  "building-3d": [
    {
      id: "housenumber",
      type: "symbol",
      source: BASE,
      "source-layer": "housenumber",
      minzoom: 17,
      layout: {
        "text-field": ["get", "housenumber"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 17, 9, 20, 12]
      },
      paint: {
        "text-color": "hsl(30, 6%, 42%)",
        "text-halo-color": "hsla(0, 0%, 100%, 0.8)",
        "text-halo-width": 1
      }
    },
    campus("entrance", "circle", 17, { paint: dot("hsl(30, 8%, 48%)", 1.5, 4) }),
    campus("amenity", "circle", 18, {
      paint: dot(["match", ["get", "kind"], "phone", "#2a6fdb", "drinking_water", "#4aa3df", "hsl(30, 30%, 52%)"] as any, 2, 5)
    }),
    // Beneath Liberty's points of interest, so a building that's one too is named once
    campus("building", "symbol", 16, {
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 16, 10.5, 20, 14],
        "text-max-width": 8
      },
      paint: {
        "text-color": "hsl(30, 8%, 34%)",
        "text-halo-color": "hsla(0, 0%, 100%, 0.85)",
        "text-halo-width": 1.25
      }
    })
  ]
}

/** Liberty's own layers, redrawn where they hide what's in the tiles */
const restyleLayer = (layer: LayerSpecification): LayerSpecification => {
  if (layer.id === "landcover_wood" && layer.type === "fill")
    return { ...layer, paint: { ...layer.paint, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 13, 0.8] } }
  if ((layer.id === "landuse_pitch" || layer.id === "landuse_track") && layer.type === "fill")
    return { ...layer, paint: { ...layer.paint, "fill-color": PITCH, "fill-outline-color": "hsl(95, 25%, 72%)" } }
  if (isRail(layer.id) && layer.type === "line")
    return {
      ...layer,
      paint: {
        ...layer.paint,
        "line-color": RAIL,
        ...layer.id.endsWith("_hatching") ? {} : { "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 12, 0.75, 15, 1.5, 20, 3] }
      }
    }
  if (layer.id === "road_path_pedestrian" || layer.id === "road_area_pattern")
    return without(layer, PLATFORM)
  if (isPoi(layer) && layer.type === "symbol") {
    const icon = layer.layout?.["icon-image"]
    return {
      ...without(layer, HIDDEN_POI) as typeof layer,
      layout: {
        ...layer.layout,
        ...icon === undefined ? {} : {
          "icon-image": ["match", ["get", "class"], ...Object.entries(ICON_ALIASES).flat(), icon] as any
        }
      }
    }
  }
  return layer
}

/**
 * Liberty made ours: its fonts and sprite from a folder of our origin, and its tiles ours where we have them
 * (src/map/basemap/tiles.mts), else from one planet build, so their URLs never change. Our campus tiles go beside
 * them, and its layers are redrawn and added to as above, the rest left as they are
 */
export const restyle = (liberty: StyleSpecification, tiles: TileJson, folder: string): StyleSpecification => ({
  ...liberty,
  glyphs: `${folder}fonts/{fontstack}/{range}.pbf`,
  sprite: `${folder}sprite`,
  sources: {
    ...liberty.sources,
    [BASE]: {
      type: "vector",
      tiles: tiles.tiles.map(upstream => tileTemplate(BASE, upstream)),
      ...tiles.minzoom === undefined ? {} : { minzoom: tiles.minzoom },
      ...tiles.maxzoom === undefined ? {} : { maxzoom: tiles.maxzoom },
      ...tiles.attribution === undefined ? {} : { attribution: tiles.attribution }
    },
    [CAMPUS]: {
      type: "vector",
      tiles: [tileTemplate(CAMPUS)],
      minzoom: TILE_SETS[CAMPUS].minzoom,
      maxzoom: TILE_SETS[CAMPUS].maxzoom
    }
  },
  // Where to find glyphs outside the ranges kept here
  metadata: { ...Object(liberty.metadata), "notunh:glyphs": liberty.glyphs },
  layers: liberty.layers.flatMap(layer => [restyleLayer(layer), ...ADDED[layer.id] ?? []])
})

/** Every font stack a style's layers name */
export const fontsOf = (style: StyleSpecification) =>
  [...new Set(style.layers.flatMap(layer => {
    const font = layer.type === "symbol" ? layer.layout?.["text-font"] : undefined
    return Array.isArray(font) && font.every(name => typeof name === "string") ? [font.join(",")] : []
  }))]

/** Our style as the map loads it, its sprite and fonts at this origin, as maplibre only takes them whole */
export const hostedAt = (style: StyleSpecification, origin: string): StyleSpecification => ({
  ...style,
  ...typeof style.glyphs === "string" && style.glyphs.startsWith("/") ? { glyphs: origin + style.glyphs } : {},
  ...typeof style.sprite === "string" && style.sprite.startsWith("/") ? { sprite: origin + style.sprite } : {}
})

/** Where our style says glyphs outside the ranges kept here come from */
export const upstreamGlyphs = (style: StyleSpecification): string | undefined => {
  const upstream: unknown = Object(style.metadata)["notunh:glyphs"]
  return typeof upstream === "string" ? upstream : undefined
}

/** Where a glyph range comes from: here if it's kept here, else from upstream, if known */
export const glyphsFrom = (url: string, upstream: string | undefined) => {
  const [, fontstack, range] = url.match(/\/([^/]+)\/(\d+-\d+)\.pbf$/) ?? []
  return upstream && range && !GLYPH_RANGES.includes(range)
    ? upstream.replace("{fontstack}", fontstack).replace("{range}", range)
    : url
}
