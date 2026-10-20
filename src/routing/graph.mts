// The walking network: junctions and dead ends joined by the paths between them, for finding the way on foot.
// Places join it at the nearest points along the paths near them, and ways are found from there by Dijkstra's
// algorithm, from whichever of several places is nearest, like a building's doors

import type Flatbush from "flatbush"
import * as v from "valibot"
import { boxOf, indexBoxes } from "../geo/boxes.mts"
import { type Line, nearestOnLine, sliceLine, toLine } from "../geo/lines.mts"
import { type Coordinates, type Point, ruler } from "../geo/projection.mts"
import { arrayOf } from "../shared/json.mts"
import { Made } from "../shared/made.mts"

/** The network as the build writes it, with where it came from */
export const WalkData = v.object({
  made:     Made,
  /** Each junction and dead end, as lon, lat in millionths of a degree, each a step from the vertex before */
  vertices: arrayOf<number>(),
  /** Each path between two vertices: its ends, how many bends lie between, then their lon, lat likewise, each a step
   * from the point before along the path */
  edges:    arrayOf<number>()
})
export type WalkData = v.InferOutput<typeof WalkData>

export type Graph = {
  /** Each edge's two vertices, the first where its line starts */
  ends:  Uint32Array,
  lines: Line[],
  /** The edges at each vertex, as incident[offsets[vertex]] up to incident[offsets[vertex + 1]] */
  offsets:  Uint32Array,
  incident: Uint32Array,
  /** Which connected part of the network each vertex is in, as there's no walking from one part to another */
  component: Uint32Array,
  /** Each edge's box, for finding the paths near a place, while there are any */
  index?: Flatbush
}

/** Where a place joins the network */
export type Anchor = {
  place: Point,
  edge: number,
  /** Meters along the edge's line */
  distance: number,
  /** Meters from the place to the edge */
  meters: number
}

export const loadGraph = ({ vertices, edges }: Omit<WalkData, "made">): Graph => {
  // Undoing the steps, in millionths of a degree until each point is done, so no rounding builds up
  const points: [number, number][] = []
  for (let i = 0; i < vertices.length; i += 2)
    points.push([(points.at(-1)?.[0] ?? 0) + vertices[i], (points.at(-1)?.[1] ?? 0) + vertices[i + 1]])
  const degrees = ([lon, lat]: [number, number]): Coordinates => [lon / 1e6, lat / 1e6]

  const ends: number[] = []
  const lines: Line[] = []
  for (let i = 0; i < edges.length;) {
    const [a, b, bends] = [edges[i], edges[i + 1], edges[i + 2]]
    const line = [points[a]]
    for (let j = 0; j < bends; j++)
      line.push([line[j][0] + edges[i + 3 + 2 * j], line[j][1] + edges[i + 4 + 2 * j]])
    line.push(points[b])
    ends.push(a, b)
    lines.push(toLine(line.map(degrees)))
    i += 3 + 2 * bends
  }

  const vertexCount = vertices.length / 2
  const offsets = new Uint32Array(vertexCount + 1)
  for (const vertex of ends)
    offsets[vertex + 1]++
  for (let vertex = 0; vertex < vertexCount; vertex++)
    offsets[vertex + 1] += offsets[vertex]
  const incident = new Uint32Array(ends.length)
  const filled = offsets.slice(0, vertexCount)
  ends.forEach((vertex, i) => incident[filled[vertex]++] = i >> 1)

  // Each vertex's part, by union-find over the edges, numbered by the lowest vertex in it
  const component = Uint32Array.from({ length: vertexCount }, (_, vertex) => vertex)
  const root = (vertex: number): number =>
    component[vertex] === vertex ? vertex : component[vertex] = root(component[vertex])
  for (let edge = 0; edge < lines.length; edge++) {
    const [a, b] = [root(ends[2 * edge]), root(ends[2 * edge + 1])]
    component[Math.max(a, b)] = Math.min(a, b)
  }
  for (let vertex = 0; vertex < vertexCount; vertex++)
    component[vertex] = root(vertex)

  return {
    ends: Uint32Array.from(ends), lines, offsets, incident, component,
    index: indexBoxes(lines.map(({ coordinates }) => boxOf(coordinates)!))
  }
}

/** The part of the network an anchor is on */
export const componentOf = (graph: Graph, { edge }: Anchor) =>
  graph.component[graph.ends[2 * edge]]

/**
 * Where a place joins the network: the nearest points of up to `count` paths passing within some meters of it,
 * nearest first, as the nearest path isn't always the best way in, and the nearest path of each other part of the
 * network within reach besides, so a place beside a path nothing else reaches is still walked from the part its
 * stops are on
 */
export const anchors = (graph: Graph, place: Point, within: number, count = 1): Anchor[] => {
  // The box is measured at the place's latitude and each path by its own ruler, which agree to a part in a hundred
  // across a county, so the box reaches that much further
  const around = ruler(place.lat).bufferPoint([place.lon, place.lat], within * 1.01)
  const found = (graph.index?.search(...around) ?? [])
    .map(edge => ({ place, edge, ...nearestOnLine(graph.lines[edge], place) }))
    .filter(anchor => anchor.meters <= within)
    .sort((a, b) => a.meters - b.meters)
  const parts = new Set<number>()
  return found.filter((anchor, i) => {
    const part = componentOf(graph, anchor)
    const isNewPart = !parts.has(part)
    parts.add(part)
    return i < count || isNewPart
  })
}

/**
 * How far it is to every vertex from the nearest of some anchors' places, up to a limit, and how each was reached: by
 * an edge, or straight from an anchor, as ~(2 * anchor + end) for the end of its edge
 */
export type Reach = {
  from:   Anchor[],
  meters: Float64Array,
  via:    Int32Array
}

/** A binary min-heap of vertices by meters, where a vertex already settled nearer is skipped when it comes up again */
const heap = () => {
  const keys: number[] = []
  const values: number[] = []
  const swap = (i: number, j: number) => {
    const [key, value] = [keys[i], values[i]]
    keys[i] = keys[j]
    values[i] = values[j]
    keys[j] = key
    values[j] = value
  }
  return {
    get size() { return keys.length },
    push(key: number, value: number) {
      keys.push(key)
      values.push(value)
      for (let i = keys.length - 1; i > 0 && keys[(i - 1) >> 1] > keys[i]; i = (i - 1) >> 1)
        swap(i, (i - 1) >> 1)
    },
    pop() {
      const top = values[0]
      const lastKey = keys.pop()!
      const lastValue = values.pop()!
      if (keys.length) {
        keys[0] = lastKey
        values[0] = lastValue
        for (let i = 0; ;) {
          const [left, right] = [2 * i + 1, 2 * i + 2]
          let smallest = i
          if (left < keys.length && keys[left] < keys[smallest])
            smallest = left
          if (right < keys.length && keys[right] < keys[smallest])
            smallest = right
          if (smallest === i)
            break
          swap(i, smallest)
          i = smallest
        }
      }
      return top
    }
  }
}

/**
 * Dijkstra's algorithm from some anchors at once, each starting out as far as its place is from the network, both
 * ways along its edge, settling vertices up to `limit` meters away
 */
export const reach = (graph: Graph, from: Anchor[], limit = Infinity): Reach => {
  const vertexCount = graph.offsets.length - 1
  const meters = new Float64Array(vertexCount).fill(Infinity)
  const via = new Int32Array(vertexCount)
  const queue = heap()
  const visit = (vertex: number, distance: number, how: number) => {
    if (distance < meters[vertex] && distance <= limit) {
      meters[vertex] = distance
      via[vertex] = how
      queue.push(distance, vertex)
    }
  }
  from.forEach(({ edge, distance, meters: offset }, i) => {
    visit(graph.ends[2 * edge], offset + distance, ~(2 * i))
    visit(graph.ends[2 * edge + 1], offset + graph.lines[edge].length - distance, ~(2 * i + 1))
  })

  const settled = new Uint8Array(vertexCount)
  while (queue.size) {
    const vertex = queue.pop()
    if (settled[vertex] || meters[vertex] > limit)
      continue
    settled[vertex] = 1
    for (let i = graph.offsets[vertex]; i < graph.offsets[vertex + 1]; i++) {
      const edge = graph.incident[i]
      const [a, b] = [graph.ends[2 * edge], graph.ends[2 * edge + 1]]
      visit(a === vertex ? b : a, meters[vertex] + graph.lines[edge].length, edge)
    }
  }
  return { from, meters, via }
}

/**
 * How a reach gets to an anchor's place: into its edge from one end, or along the edge from an anchor on it, and
 * how far that is, from the nearest anchor's place to this one's
 */
const arrival = (graph: Graph, { from, meters }: Reach, to: Anchor) => {
  const line = graph.lines[to.edge]
  const options = [
    { end: 0, source: -1, meters: meters[graph.ends[2 * to.edge]] + to.distance },
    { end: 1, source: -1, meters: meters[graph.ends[2 * to.edge + 1]] + line.length - to.distance },
    ...from.flatMap((anchor, source) =>
      anchor.edge === to.edge ? [{ end: -1, source, meters: anchor.meters + Math.abs(anchor.distance - to.distance) }] : []
    )
  ]
  const best = options.reduce((a, b) => b.meters < a.meters ? b : a)
  return { ...best, meters: best.meters + to.meters }
}

/** Meters from the nearest of a reach's places to another's, by way of the network, Infinity beyond its limit */
export const metersTo = (graph: Graph, reached: Reach, to: Anchor) =>
  arrival(graph, reached, to).meters

const coordinatesOf = ({ lon, lat }: Point): Coordinates =>
  [lon, lat]

/** The way from the nearest of a reach's places to another's: onto the network, along it, and off it */
export const pathTo = (graph: Graph, reached: Reach, to: Anchor): Coordinates[] => {
  const { end, source } = arrival(graph, reached, to)
  const ends = (from: Anchor, pieces: Coordinates[][]) =>
    [coordinatesOf(from.place), ...pieces.flatMap((piece, i) => i ? piece.slice(1) : piece), coordinatesOf(to.place)]
  if (end === -1)
    return ends(reached.from[source], [sliceLine(graph.lines[to.edge], reached.from[source].distance, to.distance)])

  // Back from the vertex the path enters the last edge by, edge by edge, to the anchor it started from
  let vertex = graph.ends[2 * to.edge + end]
  if (!(reached.meters[vertex] < Infinity))
    return []
  const pieces = [sliceLine(graph.lines[to.edge], end === 0 ? 0 : graph.lines[to.edge].length, to.distance)]
  for (let edge = reached.via[vertex]; edge >= 0; edge = reached.via[vertex]) {
    const isFirstEnd = graph.ends[2 * edge] === vertex
    const { coordinates } = graph.lines[edge]
    pieces.unshift(isFirstEnd ? [...coordinates].reverse() : coordinates)
    vertex = graph.ends[2 * edge + (isFirstEnd ? 1 : 0)]
  }
  const start = ~reached.via[vertex]
  const from = reached.from[start >> 1]
  const line = graph.lines[from.edge]
  pieces.unshift(sliceLine(line, from.distance, start & 1 ? line.length : 0))
  return ends(from, pieces)
}
