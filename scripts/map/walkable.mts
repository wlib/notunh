// The streets and paths people can walk, from OpenStreetMap ways, as the compact network the map's walking
// directions follow: junctions and dead ends joined by the paths between them, bends and all

import type { OsmElement, OsmNode } from "./pbf.mts"
import type { WalkData } from "../../src/routing/graph.mts"
import { simplify } from "../../src/geo/lines.mts"
import type { Coordinates } from "../../src/geo/projection.mts"

// Every kind of way a person can walk along, roads included, as most of Durham's streets have no separate sidewalk
export const HIGHWAYS = [
  "footway", "path", "pedestrian", "steps", "corridor", "cycleway", "bridleway", "track", "living_street",
  "residential", "service", "unclassified", "road", "tertiary", "tertiary_link", "secondary", "secondary_link",
  "primary", "primary_link"
]
const WALKABLE = new Set(HIGHWAYS)

// Bends straying less than this from a straighter path change nothing anyone walks or sees
const BEND = 1 // m
// Parts of the network with fewer paths than this are left out: a courtyard's loop or a drawn but unjoined track,
// which nothing should snap to, while a village across the river keeps its streets
const MIN_PART = 20 // paths

// Closed to the public unless it lets people walk it anyway
const CLOSED = new Set(["private", "no"])
const ON_FOOT = new Set(["yes", "designated", "permissive"])

export const isWalkable = (tags: Record<string, string>) =>
  WALKABLE.has(tags.highway) &&
  tags.foot !== "no" &&
  (!CLOSED.has(tags.access) || ON_FOOT.has(tags.foot))

/** The runs of a way's nodes that are known, split where one isn't */
const pieces = (nodes: number[], isKnown: (id: number) => boolean) => {
  const runs: number[][] = [[]]
  for (const id of nodes)
    if (isKnown(id))
      runs.at(-1)!.push(id)
    else if (runs.at(-1)!.length)
      runs.push([])
  return runs
}

/** Millionths of a degree, about 10 cm */
const fixed = (degrees: number) =>
  Math.round(degrees * 1e6)

/**
 * The walkable network among some elements: every junction or end of a way becomes a vertex, and each stretch of
 * way between two becomes an edge carrying its bends. Parts with fewer paths than `minPart` are left out, so nowhere
 * snaps to an island of path nothing else reaches, like a courtyard's
 */
export const walkGraph = (elements: OsmElement[], minPart = MIN_PART): Omit<WalkData, "made"> => {
  const nodes = new Map(elements.filter((element): element is OsmNode => element.type === "node").map(node => [node.id, node]))
  // A way listed twice is walked once, and one with a node missing is walked in the pieces either side of it, as
  // joining them would invent a path
  const ways = [...new Map(elements.flatMap(element => element.type === "way" ? [[element.id, element]] : [])).values()]
    .filter(way => isWalkable(way.tags ?? {}))
    .flatMap(way => pieces(way.nodes, id => nodes.has(id)))
    .map(way => way.filter((id, i) => id !== way[i - 1]))
    .filter(way => way.length >= 2)

  // A node is a vertex where ways meet or end
  const uses = new Map<number, number>()
  for (const way of ways)
    for (const [i, id] of way.entries())
      uses.set(id, (uses.get(id) ?? 0) + (i === 0 || i === way.length - 1 ? 2 : 1))
  const isVertex = (id: number) => uses.get(id)! >= 2

  const stretches: number[][] = []
  for (const way of ways) {
    let start = 0
    for (let i = 1; i < way.length; i++)
      if (isVertex(way[i])) {
        stretches.push(way.slice(start, i + 1))
        start = i
      }
  }

  // The parts with enough paths, by union-find over the vertices
  const parent = new Map<number, number>()
  const root = (id: number): number => {
    let top = id
    while (parent.get(top) !== undefined && parent.get(top) !== top)
      top = parent.get(top)!
    parent.set(id, top)
    return top
  }
  for (const stretch of stretches) {
    const [a, b] = [root(stretch[0]), root(stretch.at(-1)!)]
    parent.set(a, a)
    parent.set(b, a)
  }
  const sizes = new Map<number, number>()
  for (const stretch of stretches)
    sizes.set(root(stretch[0]), (sizes.get(root(stretch[0])) ?? 0) + 1)
  const kept = stretches.filter(stretch => sizes.get(root(stretch[0]))! >= minPart)

  // Coordinates are stored as steps from the point before, which are short numbers that compress well
  const index = new Map<number, number>()
  const vertices: number[] = []
  let previous = [0, 0]
  const vertexOf = (id: number) => {
    if (!index.has(id)) {
      const point = [fixed(nodes.get(id)!.lon), fixed(nodes.get(id)!.lat)]
      index.set(id, vertices.length / 2)
      vertices.push(point[0] - previous[0], point[1] - previous[1])
      previous = point
    }
    return index.get(id)!
  }
  const edges: number[] = []
  for (const stretch of kept) {
    const [a, b] = [vertexOf(stretch[0]), vertexOf(stretch.at(-1)!)]
    const line = simplify(stretch.map(id => [nodes.get(id)!.lon, nodes.get(id)!.lat] as Coordinates), BEND).map(([lon, lat]) => [fixed(lon), fixed(lat)])
    const bends: number[] = []
    for (let i = 1; i + 1 < line.length; i++)
      bends.push(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    edges.push(a, b, bends.length / 2, ...bends)
  }
  return { vertices, edges }
}
