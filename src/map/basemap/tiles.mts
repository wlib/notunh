// Our own vector tiles, made each week from one OpenStreetMap extract of New Hampshire (scripts/map/tiles.mts) and
// served from our origin in a folder named for their version (made.mts): the OpenMapTiles base map around Durham, Dover,
// and Portsmouth, and campus details OpenMapTiles leaves out. The style names them by sets, as tiles://<set>/z/x/y,
// and the map fetches each from here where the set has it, else from upstream, if the set has one, else nothing

import * as v from "valibot"
import { type Box, isInside } from "../../geo/boxes.mts"
import { Retain } from "../../shell/manifest.mts"

/** Which version of the tiles is here, if any, and its folder to keep with the map, as scripts/map/tiles.mts notes them */
export const TilesManifest = v.object({ ...Retain.entries, version: v.optional(v.string()) })
export type TilesManifest = v.InferOutput<typeof TilesManifest>

/** What each set of tiles covers: every tile wholly inside one of its boxes, at each of its zooms */
export type TileSet = { boxes: Box[], minzoom: number, maxzoom: number }

// New Hampshire only, as the extract has nothing of Maine just across the river, which a tile showing both would
// leave blank
const DURHAM: Box = [-71.02, 43.06, -70.86, 43.18]
const DOVER: Box = [-70.99, 43.15, -70.86, 43.26]
const PORTSMOUTH: Box = [-70.86, 42.98, -70.757, 43.1]
const NEW_CASTLE: Box = [-70.86, 42.98, -70.70, 43.07]

export const TILE_SETS = {
  // Where our base map is the same as OpenFreeMap's, just fresher, so a tile from either sits beside the other
  openmaptiles: { boxes: [DURHAM, DOVER, PORTSMOUTH, NEW_CASTLE], minzoom: 10, maxzoom: 14 },
  // Building names, parking lots, doors, benches, phones, fences, and trees, in a schema of our own
  // (scripts/map/campus.yml)
  campus: { boxes: [DURHAM], minzoom: 14, maxzoom: 16 }
} satisfies Record<string, TileSet>

export type TileSetName = keyof typeof TILE_SETS

export const TILES_FOLDER = "/data/map/tiles/"
export const PROTOCOL = "tiles"

const lonOf = (x: number, z: number) =>
  x / 2 ** z * 360 - 180

const latOf = (y: number, z: number) =>
  Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI

/** A tile's extent */
export const tileBox = (z: number, x: number, y: number): Box =>
  [lonOf(x, z), latOf(y + 1, z), lonOf(x + 1, z), latOf(y, z)]

/** Whether a set has a tile */
export const covers = ({ boxes, minzoom, maxzoom }: TileSet, z: number, x: number, y: number) =>
  z >= minzoom && z <= maxzoom && boxes.some(box => isInside(tileBox(z, x, y), box))

const xOf = (lon: number, z: number) =>
  Math.floor((lon + 180) / 360 * 2 ** z)

const yOf = (lat: number, z: number) =>
  Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z)

/** Every tile a set has, as [z, x, y] */
export const tilesOf = (set: TileSet) => {
  const [west, south, east, north] = extentOf(set)
  const tiles: [number, number, number][] = []
  for (let z = set.minzoom; z <= set.maxzoom; z++)
    for (let x = xOf(west, z); x <= xOf(east, z); x++)
      for (let y = yOf(north, z); y <= yOf(south, z); y++)
        if (covers(set, z, x, y))
          tiles.push([z, x, y])
  return tiles
}

/** The extent of all a set's boxes, which is what the tiles are made for */
export const extentOf = ({ boxes }: TileSet): Box =>
  [0, 1, 2, 3].map(i => (i < 2 ? Math.min : Math.max)(...boxes.map(box => box[i]))) as Box

/** A style's tile URL for a set, falling back on an upstream template where the set has no tile */
export const tileTemplate = (set: TileSetName, upstream?: string) =>
  `${PROTOCOL}://${set}/{z}/{x}/{y}${upstream ? `?else=${upstream}` : ""}`

/**
 * Where a tile comes from, in order: here, if there are tiles here and the set has this one, then upstream. None
 * at all means the tile is empty
 */
export const sourcesOf = (url: string, version: string | undefined) => {
  const [, name, z, x, y, upstream] = url.match(/^\w+:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)(?:\?else=(.+))?$/) ?? []
  const set: TileSet | undefined = TILE_SETS[name as TileSetName]
  return [
    ...version && set && covers(set, +z, +x, +y) ? [`${TILES_FOLDER}${version}/${name}/${z}/${x}/${y}.pbf`] : [],
    ...upstream ? [upstream] : []
  ]
}

/**
 * Loads a tile for maplibre from the first of its sources that has it, honoring maplibre's abort, and an empty one
 * where no source does
 */
export const tileLoader = (version: string | undefined, load = fetch) =>
  async ({ url }: { url: string }, { signal }: AbortController) => {
    for (const source of sourcesOf(url, version)) {
      const response = await load(source, { signal })
      if (response.ok)
        return { data: await response.arrayBuffer() }
    }
    return { data: new ArrayBuffer(0) }
  }
