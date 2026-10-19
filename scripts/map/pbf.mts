// OpenStreetMap's elements, read from an extract in its PBF format (https://wiki.openstreetmap.org/wiki/PBF_Format):
// the framing, blocks, and protobuf are @osmix/pbf's, what the fields mean is ours. Elements are gathered as
// Overpass would answer a query for some bounds: each with its tags, and each way and relation with its outline and
// extent

import { inflateSync } from "node:zlib"
import { type OsmPbfBlock, createOsmPbfBlobFrameGenerator, osmPbfBlobsToBlocksGenerator } from "@osmix/pbf"
import { type Box, boxOf } from "../../src/geo/boxes.mts"
import type { Coordinates, Point } from "../../src/geo/projection.mts"

export type Tags = Record<string, string>

export type OsmNode = { type: "node", id: number, lat: number, lon: number, tags?: Tags }
export type OsmWay = {
  type:  "way",
  id:    number,
  nodes: number[],
  tags:  Tags,
  /** Its outline, and its extent, once gathered */
  geometry?: Point[],
  bounds?:   Box
}
export type OsmMember = { type: "node" | "way" | "relation", ref: number, role: string, geometry?: Point[] }
export type OsmRelation = {
  type:    "relation",
  id:      number,
  tags:    Tags,
  /** Its parts, with their outlines, and its extent, likewise */
  members: OsmMember[],
  bounds?: Box
}
export type OsmElement = OsmNode | OsmWay | OsmRelation

/** A file that ends before its framing says it does, as a download cut short, or before it begins */
export class TruncatedPbf extends Error {
  constructor(options?: ErrorOptions) {
    super("The PBF file ends partway through a blob", options)
  }
}

/**
 * Each blob, still deflated, from a file's framing as its bytes come, which only once they've all come can say
 * whether it was cut short, as one with none at all was
 */
const blobsOf = async function* (extract: AsyncIterable<Uint8Array>) {
  const frames = createOsmPbfBlobFrameGenerator()
  let isEmpty = true
  for await (const chunk of extract) {
    isEmpty &&= !chunk.length
    yield* frames.nextChunk(chunk)
  }
  try {
    if (isEmpty)
      throw new Error("The file is empty")
    frames.finish()
  }
  catch (cause) {
    throw new TruncatedPbf({ cause })
  }
}

/** zlib, inflated in one go, as a blob is at most a few MB, up to the most it may hold */
const inflate = async (data: Uint8Array, maxOutputLength?: number) =>
  new Uint8Array(inflateSync(data, { maxOutputLength }))

/** Numbers stored as their differences from the one before */
const undelta = (deltas: number[]) => {
  let sum = 0
  return deltas.map(delta => sum += delta)
}

const withTags = (tags: Tags) =>
  Object.keys(tags).length ? { tags } : {}

const MEMBER_TYPES = ["node", "way", "relation"] as const

const text = new TextDecoder()

/** What to do with each kind of element */
export type Readers = {
  node?:     (node: OsmNode) => void,
  way?:      (way: OsmWay) => void,
  relation?: (relation: OsmRelation) => void
}

/** Each element of a block, by the strings and coordinate coding it carries */
const readBlock = ({ stringtable, primitivegroup, granularity, lat_offset, lon_offset }: OsmPbfBlock, { node, way, relation }: Readers) => {
  const strings = stringtable.map(bytes => text.decode(bytes))
  const tagged = (keys: number[], values: number[]): Tags =>
    Object.fromEntries(keys.map((key, i) => [strings[key], strings[values[i]]]))
  // @osmix/pbf gives the coding in degrees, which can't hold every stored decimal, so it's taken back to the
  // billionths it's stored in, and each coordinate divided once, to read as exactly the decimal it was stored as
  const step = Math.round(1e9 / (granularity ?? 1e7))
  const [latOffset, lonOffset] = [lat_offset, lon_offset].map(offset => Math.round((offset ?? 0) * 1e9))
  const degrees = (offset: number, value: number) => (offset + step * value) / 1e9

  for (const group of primitivegroup) {
    if (node) {
      for (const one of group.nodes)
        node({ type: "node", id: one.id, lat: degrees(latOffset, one.lat), lon: degrees(lonOffset, one.lon), ...withTags(tagged(one.keys, one.vals)) })
      if (group.dense) {
        const { id, lat, lon, keys_vals } = group.dense
        const [ids, lats, lons] = [id, lat, lon].map(undelta)
        let at = 0
        for (const [i, id] of ids.entries()) {
          const tags: Tags = {}
          // Each node's keys and values in turn, ended by a 0, or none at all when no node has tags
          for (; at < keys_vals.length && keys_vals[at] !== 0; at += 2)
            tags[strings[keys_vals[at]]] = strings[keys_vals[at + 1]]
          at++
          node({ type: "node", id, lat: degrees(latOffset, lats[i]), lon: degrees(lonOffset, lons[i]), ...withTags(tags) })
        }
      }
    }
    if (way)
      for (const one of group.ways)
        way({ type: "way", id: one.id, nodes: undelta(one.refs), tags: tagged(one.keys, one.vals) })
    if (relation)
      for (const one of group.relations)
        relation({
          type:    "relation",
          id:      one.id,
          tags:    tagged(one.keys, one.vals),
          members: undelta(one.memids).map((ref, i) => ({ type: MEMBER_TYPES[one.types[i]], ref, role: strings[one.roles_sid[i]] }))
        })
  }
}

/** Reads every element of an extract in order, as its bytes come, and says when the extract was taken, if it says */
export const readPbf = async (extract: AsyncIterable<Uint8Array>, readers: Readers) => {
  let timestamp: Date | undefined
  // The header first, then every block
  for await (const block of osmPbfBlobsToBlocksGenerator(blobsOf(extract), inflate)) {
    if ("primitivegroup" in block)
      readBlock(block, readers)
    else if (block.osmosis_replication_timestamp)
      timestamp = new Date(block.osmosis_replication_timestamp * 1000)
  }
  return { timestamp }
}

/** Every node's place, by id, kept as sorted columns, as an extract has millions of them */
const nodePlaces = () => {
  let [ids, lats, lons] = [new Float64Array(1 << 16), new Float64Array(1 << 16), new Float64Array(1 << 16)]
  let count = 0
  const add = ({ id, lat, lon }: OsmNode) => {
    if (count && id <= ids[count - 1])
      throw new Error("An extract's nodes aren't sorted by id")
    if (count === ids.length)
      [ids, lats, lons] = [ids, lats, lons].map(column => {
        const longer = new Float64Array(column.length * 2)
        longer.set(column)
        return longer
      })
    ids[count] = id
    lats[count] = lat
    lons[count++] = lon
  }
  const get = (id: number): Point | undefined => {
    let [low, high] = [0, count - 1]
    while (low <= high) {
      const middle = (low + high) >> 1
      if (ids[middle] === id)
        return { lat: lats[middle], lon: lons[middle] }
      if (ids[middle] < id)
        low = middle + 1
      else
        high = middle - 1
    }
  }
  return { add, get }
}

const extentOf = (points: Point[]) =>
  boxOf(points.map(({ lon, lat }): Coordinates => [lon, lat]))

const isWithin = ([west, south, east, north]: Box) => ({ lat, lon }: Point) =>
  lat >= south && lat <= north && lon >= west && lon <= east

/**
 * The elements of an extract with tags wanted that reach into a box, as an Overpass query for them would answer it
 * with `out geom`: each way and relation with its outline and extent, and every node of the ways wanted besides, so
 * their paths can be followed past the box. Read in two passes, relations first, so only the ways that wanted
 * relations are made of are kept besides the wanted ways
 */
export const elementsWithin = async (read: () => AsyncIterable<Uint8Array>, box: Box, isWanted: (tags: Tags) => boolean) => {
  const inside = isWithin(box)
  const relations: OsmRelation[] = []
  const parts = new Set<number>()
  await readPbf(read(), {
    relation: relation => {
      if (!isWanted(relation.tags))
        return
      relations.push(relation)
      for (const member of relation.members)
        if (member.type === "way")
          parts.add(member.ref)
    }
  })

  const places = nodePlaces()
  const nodes = new Map<number, OsmNode>()
  const ways = new Map<number, OsmWay>()
  const { timestamp } = await readPbf(read(), {
    node: node => {
      places.add(node)
      if (node.tags && isWanted(node.tags) && inside(node))
        nodes.set(node.id, node)
    },
    way: way => {
      if (isWanted(way.tags) || parts.has(way.id))
        ways.set(way.id, way)
    }
  })

  const outlineOf = (way: OsmWay) =>
    way.nodes.flatMap(id => places.get(id) ?? [])
  const wanted: OsmWay[] = []
  for (const way of ways.values()) {
    const geometry = outlineOf(way)
    if (isWanted(way.tags) && geometry.some(inside))
      wanted.push({ ...way, geometry, bounds: extentOf(geometry) })
  }
  const nodesOfWays = wanted.flatMap(way => way.nodes)
    .filter(id => !nodes.has(id))
    .flatMap(id => {
      const place = places.get(id)
      return place ? [{ type: "node" as const, id, ...place }] : []
    })

  const gathered = relations.flatMap((relation): OsmRelation[] => {
    const members = relation.members.map(member => {
      const way = member.type === "way" ? ways.get(member.ref) : undefined
      return way ? { ...member, geometry: outlineOf(way) } : member
    })
    const corners = members.flatMap(member => member.geometry ?? [])
    return corners.some(inside) ? [{ ...relation, members, bounds: extentOf(corners) }] : []
  })

  const elements: OsmElement[] = [...nodes.values(), ...new Map(nodesOfWays.map(node => [node.id, node])).values(), ...wanted, ...gathered]
  return { elements, timestamp }
}
