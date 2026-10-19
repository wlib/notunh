import { test, expect } from "vitest"
import fc from "fast-check"
import { Readable } from "node:stream"
import { deflateSync } from "node:zlib"
import { type OsmElement, type OsmNode, type OsmRelation, type OsmWay, TruncatedPbf, elementsWithin, readPbf } from "../../scripts/map/pbf.mts"
import type { Box } from "../../src/geo/boxes.mts"

// Just enough of a protobuf encoder to write extracts by hand

const varint = (value: number) => {
  const bytes: number[] = []
  for (; value >= 0x80; value = Math.floor(value / 0x80))
    bytes.push(value % 0x80 + 0x80)
  return [...bytes, value]
}

const zigzag = (value: number) =>
  value < 0 ? -2 * value - 1 : 2 * value

const field = (number: number, value: number | number[] | Uint8Array) =>
  typeof value === "number"
    ? [...varint(number * 8), ...varint(value)]
    : [...varint(number * 8 + 2), ...varint(value.length), ...value]

const text = (value: string) =>
  [...new TextEncoder().encode(value)]

const packed = (values: number[]) =>
  values.flatMap(varint)

const deltas = (values: number[]) =>
  values.map((value, i) => zigzag(value - (values[i - 1] ?? 0)))

/** A file of blobs, each deflated, as every extract's are */
const file = (blobs: [string, number[]][]) =>
  new Uint8Array(blobs.flatMap(([type, contents]) => {
    const blob = [...field(2, contents.length), ...field(3, [...deflateSync(new Uint8Array(contents))])]
    const header = [...field(1, text(type)), ...field(3, blob.length)]
    return [...[24, 16, 8, 0].map(shift => header.length >> shift & 0xff), ...header, ...blob]
  }))

type Coding = { granularity: number, latOffset: number, lonOffset: number, isDense: boolean }

/** A block of elements, its strings in a table of their own, and its nodes dense or each on its own */
const block = (elements: OsmElement[], { granularity, latOffset, lonOffset, isDense }: Coding) => {
  const strings = [""]
  const index = (value: string) =>
    strings.includes(value) ? strings.indexOf(value) : strings.push(value) - 1
  const keys = (tags: Record<string, string> = {}) => Object.keys(tags).map(index)
  const values = (tags: Record<string, string> = {}) => Object.values(tags).map(index)
  const fixed = (degrees: number, offset: number) => Math.round((degrees * 1e9 - offset) / granularity)

  const nodes = elements.filter((element): element is OsmNode => element.type === "node")
  const ways = elements.filter((element): element is OsmWay => element.type === "way")
  const relations = elements.filter((element): element is OsmRelation => element.type === "relation")
  const groups = [
    ...!nodes.length ? [] : isDense
      ? [field(2, [
        ...field(1, packed(deltas(nodes.map(node => node.id)))),
        ...field(8, packed(deltas(nodes.map(node => fixed(node.lat, latOffset))))),
        ...field(9, packed(deltas(nodes.map(node => fixed(node.lon, lonOffset))))),
        ...field(10, packed(nodes.flatMap(node => [...keys(node.tags).flatMap((key, i) => [key, values(node.tags)[i]]), 0])))
      ])]
      : [nodes.flatMap(node => field(1, [
        ...field(1, zigzag(node.id)), ...field(2, packed(keys(node.tags))), ...field(3, packed(values(node.tags))),
        ...field(8, zigzag(fixed(node.lat, latOffset))), ...field(9, zigzag(fixed(node.lon, lonOffset)))
      ]))],
    ...ways.length ? [ways.flatMap(way => field(3, [
      ...field(1, way.id), ...field(2, packed(keys(way.tags))), ...field(3, packed(values(way.tags))), ...field(8, packed(deltas(way.nodes)))
    ]))] : [],
    ...relations.length ? [relations.flatMap(relation => field(4, [
      ...field(1, relation.id), ...field(2, packed(keys(relation.tags))), ...field(3, packed(values(relation.tags))),
      ...field(8, packed(relation.members.map(member => index(member.role)))),
      ...field(9, packed(deltas(relation.members.map(member => member.ref)))),
      ...field(10, packed(relation.members.map(member => ["node", "way", "relation"].indexOf(member.type))))
    ]))] : []
  ]
  return [
    ...field(1, strings.flatMap(value => field(1, text(value)))),
    ...groups.flatMap(group => field(2, group)),
    ...field(17, granularity), ...field(19, latOffset), ...field(20, lonOffset)
  ]
}

const blobs = (elements: OsmElement[], coding: Coding, timestamp?: number): [string, number[]][] => [
  ["OSMHeader", [...field(4, text("OsmSchema-V0.6")), ...timestamp ? field(32, timestamp) : []]],
  ["OSMData", block(elements, coding)]
]

const pbf = (elements: OsmElement[], coding: Coding, timestamp?: number) =>
  file(blobs(elements, coding, timestamp))

/** A file's elements, read from its bytes as they come, cut where asked */
const read = async (data: Uint8Array, cuts: number[] = []) => {
  const elements: OsmElement[] = []
  const add = (element: OsmElement) => void elements.push(element)
  const at = [...new Set(cuts.map(cut => cut % (data.length + 1)))].sort((a, b) => a - b)
  const chunks = async function* () {
    for (const [i, from] of [0, ...at].entries())
      yield data.subarray(from, [...at, data.length][i])
  }
  const { timestamp } = await readPbf(chunks(), { node: add, way: add, relation: add })
  return { elements, timestamp }
}

// Never empty, as OpenStreetMap's aren't, and the format keeps the empty string to end a node's tags
const tags = fc.dictionary(fc.constantFrom("name", "highway", "building", "amenity", "entrance", "ref:é"), fc.string({ minLength: 1, maxLength: 12 }), { maxKeys: 3 })
// OpenStreetMap's ids run past 2³², and its coordinates are stored to the ten-millionth of a degree
const ids = fc.uniqueArray(fc.integer({ min: 1, max: 2 ** 40 }), { minLength: 1, maxLength: 30 }).map(ids => ids.sort((a, b) => a - b))
const degrees = (max: number) => fc.integer({ min: -max * 1e7, max: max * 1e7 }).map(value => value / 1e7)

const elements = ids.chain(nodeIds => fc.tuple(
  fc.tuple(...nodeIds.map(id => fc.record({ lat: degrees(90), lon: degrees(180), tags }).map(({ tags, ...place }): OsmNode =>
    ({ type: "node", id, ...place, ...Object.keys(tags).length ? { tags } : {} })
  ))),
  fc.uniqueArray(fc.record({
    id: fc.integer({ min: 1, max: 2 ** 40 }),
    nodes: fc.array(fc.constantFrom(...nodeIds), { maxLength: 8 }),
    tags
  }), { maxLength: 6, selector: way => way.id }).map(ways => ways.map((way): OsmWay => ({ type: "way", ...way }))),
  fc.uniqueArray(fc.record({
    id: fc.integer({ min: 1, max: 2 ** 40 }),
    members: fc.array(fc.record({
      type: fc.constantFrom("node" as const, "way" as const, "relation" as const),
      ref: fc.integer({ min: 1, max: 2 ** 40 }),
      role: fc.constantFrom("", "outer", "inner")
    }), { maxLength: 5 }),
    tags
  }), { maxLength: 4, selector: relation => relation.id }).map(relations => relations.map((relation): OsmRelation => ({ type: "relation", ...relation })))
).map(([nodes, ways, relations]): OsmElement[] => [...nodes, ...ways, ...relations]))

const coding = fc.record({
  // In billionths, as fine as the coordinates are
  granularity: fc.constant(100),
  latOffset: fc.nat(1e4).map(offset => offset * 100),
  lonOffset: fc.nat(1e4).map(offset => offset * 100),
  isDense: fc.boolean()
})

test("every node, way, and relation reads back as it was written, dense or not, however its bytes come", () =>
  fc.assert(fc.asyncProperty(elements, coding, fc.option(fc.integer({ min: 1, max: 2 ** 33 }), { nil: undefined }), fc.array(fc.nat(), { maxLength: 4 }), async (written, coding, seconds, cuts) => {
    const { elements, timestamp } = await read(pbf(written, coding, seconds), cuts)
    expect(elements).toEqual(written)
    expect(timestamp).toEqual(seconds ? new Date(seconds * 1000) : undefined)
  }))
)

test("only the kinds of elements asked for are read", async () => {
  const written: OsmElement[] = [
    { type: "node", id: 1, lat: 43.1, lon: -70.9 },
    { type: "way", id: 2, nodes: [1], tags: {} }
  ]
  const ways: OsmWay[] = []
  await readPbf(Readable.from([pbf(written, { granularity: 100, latOffset: 0, lonOffset: 0, isDense: true })]), { way: way => void ways.push(way) })
  expect(ways).toEqual([written[1]])
})

test("the elements within some bounds have their outlines and extents, and the wanted ways' nodes come along", async () => {
  const node = (id: number, lat: number, lon: number, tags?: Record<string, string>): OsmNode =>
    ({ type: "node", id, lat, lon, ...tags ? { tags } : {} })
  const written: OsmElement[] = [
    node(1, 43.10, -70.95),
    node(2, 43.12, -70.93),
    // Past the bounds, but along a path that's within them
    node(3, 43.30, -70.93),
    node(4, 43.11, -70.94, { amenity: "cafe", name: "Zeke's" }),
    node(5, 43.11, -70.94, { amenity: "bench" }),
    node(6, 43.50, -70.50, { amenity: "cafe", name: "Far Away" }),
    node(7, 43.13, -70.92),
    node(8, 43.13, -70.91),
    node(9, 43.14, -70.91),
    { type: "way", id: 10, nodes: [1, 2, 3], tags: { highway: "footway" } },
    { type: "way", id: 11, nodes: [3, 6], tags: { highway: "footway" } },
    // A relation's outline, wanted only as its part
    { type: "way", id: 12, nodes: [7, 8, 9, 7], tags: {} },
    { type: "relation", id: 13, tags: { building: "yes", name: "Hall" }, members: [{ type: "way", ref: 12, role: "outer" }] }
  ]
  const box: Box = [-71.0, 43.0, -70.9, 43.2]
  const { elements, timestamp } = await elementsWithin(
    () => Readable.from([pbf(written, { granularity: 100, latOffset: 0, lonOffset: 0, isDense: true }, 1_760_000_000)]),
    box,
    tags => !!tags.highway || !!tags.name
  )
  expect(timestamp).toEqual(new Date(1_760_000_000_000))
  const extent = (minlat: number, minlon: number, maxlat: number, maxlon: number): Box => [minlon, minlat, maxlon, maxlat]
  expect(elements).toEqual([
    node(4, 43.11, -70.94, { amenity: "cafe", name: "Zeke's" }),
    node(1, 43.10, -70.95),
    node(2, 43.12, -70.93),
    node(3, 43.30, -70.93),
    {
      type: "way", id: 10, nodes: [1, 2, 3], tags: { highway: "footway" },
      geometry: [{ lat: 43.10, lon: -70.95 }, { lat: 43.12, lon: -70.93 }, { lat: 43.30, lon: -70.93 }],
      bounds: extent(43.10, -70.95, 43.30, -70.93)
    },
    {
      type: "relation", id: 13, tags: { building: "yes", name: "Hall" },
      members: [{ type: "way", ref: 12, role: "outer", geometry: [{ lat: 43.13, lon: -70.92 }, { lat: 43.13, lon: -70.91 }, { lat: 43.14, lon: -70.91 }, { lat: 43.13, lon: -70.92 }] }],
      bounds: extent(43.13, -70.92, 43.14, -70.91)
    }
  ])
})

test("a file cut short at any byte is refused as truncated, or read up to the last whole blob, and never hangs", () =>
  fc.assert(fc.asyncProperty(elements, coding, async (written, coding) => {
    const parts = blobs(written, coding, 1_760_000_000)
    const whole = file(parts)
    // Where each blob but the first ends, which is where a shorter file could end whole
    const ends = new Set(parts.slice(1).map((_, i) => file(parts.slice(0, i + 1)).length))
    for (let length = 0; length < whole.length; length++) {
      const cut = read(whole.subarray(0, length))
      if (ends.has(length))
        expect((await cut).elements).toEqual([])
      else
        await expect(cut).rejects.toThrow(TruncatedPbf)
    }
    expect((await read(whole)).elements).toEqual(written)
  }), { numRuns: 30 })
)
