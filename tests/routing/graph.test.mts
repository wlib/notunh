import { test, expect } from "vitest"
import fc from "fast-check"
import { walkGraph } from "../../scripts/map/walkable.mts"
import type { OsmElement } from "../../scripts/map/pbf.mts"
import { type Anchor, type Graph, anchors, loadGraph, metersTo, pathTo, reach } from "../../src/routing/graph.mts"
import { nearestOnLine } from "../../src/geo/lines.mts"
import { type Coordinates, distance, ruler, segmentMeters, straightMeters } from "../../src/geo/projection.mts"
import { createWalks } from "../../src/routing/walks.mts"
import type { GazetteerPlace } from "../../src/places/gazetteer.mts"

const CENTER = { lat: 43.135, lon: -70.93 }
// Everything here is within a few kilometers
const ANYWHERE = 10_000 // m

/** The nearest path's anchor for a spot */
const anchor = (graph: Graph, place: { lat: number, lon: number }, within = ANYWHERE) =>
  anchors(graph, place, within)[0]

// Distinct spots within a couple of kilometers, on a grid of about a meter
const spot = fc
  .tuple(fc.integer({ min: -2000, max: 2000 }), fc.integer({ min: -2000, max: 2000 }))
  .map(([y, x]): Coordinates => [CENTER.lon + x * 1.4e-5, CENTER.lat + y * 1e-5])

/** A connected network of footpaths: a chain through every spot, plus shortcuts, each with a few bends */
const network = fc
  .uniqueArray(spot, { minLength: 2, maxLength: 9, selector: ([lon, lat]) => `${lon},${lat}` })
  .chain(spots => fc.record({
    spots: fc.constant(spots),
    shortcuts: fc.array(fc.tuple(fc.nat(spots.length - 1), fc.nat(spots.length - 1)), { maxLength: 6 }),
    bends: fc.array(fc.array(spot, { maxLength: 2 }), { minLength: spots.length + 6, maxLength: spots.length + 6 })
  }))
  .map(({ spots, shortcuts, bends }) => {
    const pairs = [...spots.slice(1).map((_, i) => [i, i + 1]), ...shortcuts.filter(([a, b]) => a !== b)]
    // One node per place, so a bend on a spot or another bend is a junction, as the distances below take it to be
    const nodes = new Map<string, number>()
    const elements: OsmElement[] = []
    const node = ([lon, lat]: Coordinates) => {
      const key = `${lon},${lat}`
      if (!nodes.has(key)) {
        nodes.set(key, nodes.size + 1)
        elements.push({ type: "node", id: nodes.size, lat, lon })
      }
      return nodes.get(key)!
    }
    pairs.forEach(([a, b], i) => elements.push({
      type: "way",
      id: i + 1,
      tags: { highway: "footway" },
      nodes: [node(spots[a]), ...bends[i].map(node), node(spots[b])]
    }))
    const at = (id: number) => elements.find(element => element.type === "node" && element.id === id) as { lat: number, lon: number }
    const ways = elements.filter(element => element.type === "way").map(way => way.nodes.map(at))
    return { spots, ways, elements, graph: loadGraph(walkGraph(elements, 1)) }
  })

/** Shortest distances between every pair of spots along the ways themselves, by Floyd–Warshall */
const allPairs = (spots: Coordinates[], ways: { lat: number, lon: number }[][]) => {
  const keys = new Map<string, number>()
  const id = ({ lat, lon }: { lat: number, lon: number }) => {
    const key = `${lon},${lat}`
    if (!keys.has(key))
      keys.set(key, keys.size)
    return keys.get(key)!
  }
  spots.forEach(([lon, lat]) => id({ lat, lon }))
  const steps = ways.flatMap(way => way.slice(1).map((point, i) => [id(way[i]), id(point), segmentMeters([way[i].lon, way[i].lat], [point.lon, point.lat])]))
  const n = keys.size
  const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : Infinity))
  for (const [a, b, meters] of steps) {
    d[a][b] = Math.min(d[a][b], meters)
    d[b][a] = Math.min(d[b][a], meters)
  }
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j])
  return d
}

/**
 * A spot as an anchor at the start or end of an edge that meets there, any of which is the same vertex, or undefined
 * if none does. Unlike the nearest anchor, it can't tie with a way that passes through the spot without meeting there
 */
const atSpot = (graph: Graph, [lon, lat]: Coordinates): Anchor | undefined => {
  for (const [edge, line] of graph.lines.entries())
    for (const end of [0, 1]) {
      const [x, y] = line.coordinates[end ? line.coordinates.length - 1 : 0]
      if (Math.abs(x - lon) < 1e-9 && Math.abs(y - lat) < 1e-9)
        return { place: { lat, lon }, edge, distance: end ? line.length : 0, meters: 0 }
    }
}

const pathMeters = (path: Coordinates[]) =>
  path.slice(1).reduce((sum, point, i) => sum + segmentMeters(path[i], point), 0)

test("the network keeps the length of every way between junctions, and finds the shortest way between them", () =>
  fc.assert(fc.property(network, ({ spots, ways, graph }) => {
    const d = allPairs(spots, ways)
    spots.forEach((a, i) => {
      const reached = reach(graph, [atSpot(graph, a)!])
      // Bends within a meter of a straighter way are left out, which shortens a way by little: a bend a meter off a
      // pair of meter-long stretches is the most there is to lose. Measured by each way's own ruler rather than at
      // each segment, a straightened way can also come out a hair longer
      spots.forEach((b, j) => {
        const meters = metersTo(graph, reached, atSpot(graph, b)!)
        expect(meters).toBeLessThanOrEqual(d[i][j] * (1 + 1e-3) + 0.01)
        expect(meters).toBeGreaterThan(d[i][j] - 1)
      })
    })
  }))
)

test("ways are as long one way as the other, and their paths are as long as they say, from place to place", () =>
  fc.assert(fc.property(network, spot, spot, ({ graph }, a, b) => {
    const [from, to] = [a, b].map(([lon, lat]) => anchor(graph, { lat, lon }))
    const there = reach(graph, [from])
    const back = reach(graph, [to])
    expect(metersTo(graph, there, to)).toBeCloseTo(metersTo(graph, back, from), 3)
    const path = pathTo(graph, there, to)
    // Measured by each way's own ruler rather than at each segment, a path comes out a hair different
    expect(Math.abs(pathMeters(path) - metersTo(graph, there, to))).toBeLessThan(1e-3 * pathMeters(path) + 0.01)
    expect(path[0]).toEqual(a)
    expect(path.at(-1)).toEqual(b)
  }))
)

test("a reach from several places at once is as near everywhere as the nearest of them, and its paths start there", () =>
  fc.assert(fc.property(network, fc.array(spot, { minLength: 1, maxLength: 4 }), spot, ({ graph }, starts, end) => {
    const from = starts.map(([lon, lat]) => anchor(graph, { lat, lon }))
    const to = anchor(graph, { lat: end[1], lon: end[0] })
    const together = reach(graph, from)
    const apart = from.map(anchor => reach(graph, [anchor]))
    together.meters.forEach((meters, vertex) =>
      expect(meters).toBeCloseTo(Math.min(...apart.map(reached => reached.meters[vertex])), 6)
    )
    const nearest = Math.min(...apart.map(reached => metersTo(graph, reached, to)))
    expect(metersTo(graph, together, to)).toBeCloseTo(nearest, 6)
    const path = pathTo(graph, together, to)
    expect(Math.abs(pathMeters(path) - nearest)).toBeLessThan(1e-3 * pathMeters(path) + 0.01)
    expect(starts).toContainEqual(path[0])
  }))
)

test("a place joins the network at the nearest points of the nearest few paths, none beyond the distance asked", () =>
  fc.assert(fc.property(network, spot, fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 1, max: 4 }), ({ graph }, [lon, lat], within, count) => {
    const byPath = graph.lines.map(line => nearestOnLine(line, { lat, lon }).meters).filter(meters => meters <= within).sort((a, b) => a - b)
    const found = anchors(graph, { lat, lon }, within, count)
    expect(found.map(anchor => anchor.meters)).toEqual(byPath.slice(0, count).map(meters => expect.closeTo(meters, 6)))
    expect(new Set(found.map(anchor => anchor.edge)).size).toBe(found.length)
  }))
)

test("joining by the nearest few paths is never a longer way than by the nearest alone", () =>
  fc.assert(fc.property(network, spot, spot, ({ graph }, a, b) => {
    const [from, to] = [a, b].map(([lon, lat]) => ({ lat, lon }))
    const end = anchor(graph, to)
    const byNearest = metersTo(graph, reach(graph, [anchor(graph, from)]), end)
    const byAny = metersTo(graph, reach(graph, anchors(graph, from, ANYWHERE, 3)), end)
    expect(byAny).toBeLessThanOrEqual(byNearest + 1e-6)
  }))
)

test("renumbering the network's vertices changes no distance, and taking a path away never shortens one", () =>
  fc.assert(fc.property(network, fc.nat(), fc.nat(), ({ spots, elements, graph }, seed, drop) => {
    const nodes = elements.filter(element => element.type === "node")
    const ways = elements.filter(element => element.type === "way")
    // Vertices are numbered as ways come, so the same ways in another order are the same network renumbered
    const shuffled = [...ways].sort((a, b) => (a.id * 7919 + seed) % 1009 - (b.id * 7919 + seed) % 1009)
    const renumbered = loadGraph(walkGraph([...nodes, ...shuffled], 1))
    const fewer = loadGraph(walkGraph([...nodes, ...ways.filter((_, i) => i !== drop % ways.length)], 1))
    /**
     * Meters from each spot to each other, by the network, for spots still at a junction or end of it, from the vertex
     * there rather than the nearest point of any way, which may as well be a way passing through it
     */
    const table = (graph: Graph) => {
      const at = spots.map(spot => atSpot(graph, spot))
      return spots.map((_, i) => {
        const from = at[i]
        const reached = from && reach(graph, [from])
        return spots.map((_, j) => reached && at[j] ? metersTo(graph, reached, at[j]) : undefined)
      })
    }
    const [before, after, without] = [graph, renumbered, fewer].map(table)
    spots.forEach((_, i) => spots.forEach((_, j) => {
      if (before[i][j] !== undefined)
        expect(after[i][j]).toBeCloseTo(before[i][j], 6)
      if (without[i][j] !== undefined)
        expect(without[i][j]).toBeGreaterThanOrEqual(before[i][j]! - 1e-6)
    }))
  }))
)

test("a reach with a limit finds everything within it as a reach without one does", () =>
  fc.assert(fc.property(network, spot, fc.integer({ min: 0, max: 3000 }), ({ graph }, [lon, lat], limit) => {
    const from = anchor(graph, { lat, lon })
    const [limited, full] = [reach(graph, [from], limit), reach(graph, [from])]
    full.meters.forEach((meters, vertex) => {
      if (meters <= limit)
        expect(limited.meters[vertex]).toBeCloseTo(meters, 6)
    })
  }))
)

test("walking along the network is never shorter than a straight line, and off it walks are a straight line's allowance, said to be estimates", () =>
  fc.assert(fc.property(network, fc.array(spot, { minLength: 1, maxLength: 5 }), spot, ({ graph }, stops, [lon, lat]) => {
    const place = { lat, lon }
    const stopPlaces = stops.map(([lon, lat]) => ({ lat, lon }))
    const [onNetwork, offNetwork] = [createWalks(stopPlaces, graph), createWalks(stopPlaces)]
    // Give or take the network's vertices being kept to the millionth of a degree, and flat frames at either latitude
    onNetwork.toStops(place).meters.forEach((meters, i) => expect(meters).toBeGreaterThanOrEqual(distance(place, stopPlaces[i]) * (1 - 1e-3) - 0.2))
    const off = offNetwork.toStops(place)
    off.meters.forEach((meters, i) => {
      const straight = straightMeters(place, stopPlaces[i])
      expect(meters).toBe(straight <= 2000 ? straight : Infinity)
      expect(off.via[i]).toBe("estimate")
    })
    expect(offNetwork.between(place, stopPlaces[0])).toMatchObject({ meters: straightMeters(place, stopPlaces[0]), via: "estimate" })
    // Transfers among the stops carry the same word
    for (const transfers of offNetwork.transfers())
      for (const transfer of transfers)
        expect(transfer).toMatchObject({ meters: expect.any(Number), via: "estimate" })
  }))
)

/** Two networks a few kilometers apart, which nothing joins */
const twoNetworks = fc.tuple(network, network).map(([a, b]) => {
  const east = 0.1
  const moved = b.elements.map(element =>
    element.type === "node" ? { ...element, id: element.id + 1000, lon: element.lon + east } :
    element.type === "way"  ? { ...element, id: element.id + 1000, nodes: element.nodes.map(id => id + 1000) } :
                              element
  )
  return {
    near: a.spots,
    far:  b.spots.map(([lon, lat]): Coordinates => [lon + east, lat]),
    graph: loadGraph(walkGraph([...a.elements, ...moved], 1))
  }
})

test("places on parts of the network nothing joins are walked between in a straight line, and said to be", () =>
  fc.assert(fc.property(twoNetworks, fc.nat(), fc.nat(), ({ near, far, graph }, i, j) => {
    const [a, b, c] = [near[i % near.length], near[(i + 1) % near.length], far[j % far.length]].map(([lon, lat]) => ({ lat, lon }))
    const walks = createWalks([b, c], graph)
    expect(walks.between(a, b).via).toBe("network")
    expect(walks.between(a, c)).toMatchObject({ meters: straightMeters(a, c), via: "estimate" })
    const { meters: [toNear, toFar], via } = walks.toStops(a)
    expect(toNear).toBeGreaterThanOrEqual(distance(a, b) * (1 - 1e-3) - 0.2)
    expect(toFar).toBe(straightMeters(a, c) <= 2000 ? straightMeters(a, c) : Infinity)
    expect(via).toEqual(["network", "estimate"])
    // A transfer between the parts is an estimate too, as the planner is told
    expect(walks.transfers()[0]).toEqual(straightMeters(b, c) <= 500 ? [{ to: 1, meters: straightMeters(b, c), via: "estimate" }] : [])
  }))
)

/** A building around a place, a few meters across, with some doors */
const buildingAround = ([lon, lat]: Coordinates, doors: Coordinates[], name = "Hall"): GazetteerPlace => ({
  name,
  kind: "building",
  at: [lon, lat],
  extent: [lon - 5e-5, lat - 5e-5, lon + 5e-5, lat + 5e-5],
  entrances: doors
})

/** A network, and some doors and a stop on it */
const doorsAndStop = network.chain(({ spots, graph }) => fc.record({
  graph: fc.constant(graph),
  doors: fc.subarray(spots, { minLength: 1 }),
  stop:  fc.constantFrom(...spots)
}))

test("a building is walked to and from by its nearest door, never further than by any one of them", () =>
  fc.assert(fc.property(
    doorsAndStop,
    spot,
    ({ graph, doors, stop: [stopLon, stopLat] }, [lon, lat]) => {
      const [place, stop] = [{ lat, lon }, { lat: stopLat, lon: stopLon }]
      const walkFrom = (doors: Coordinates[]) => createWalks([stop], graph, [buildingAround([lon, lat], doors)])
      const byEach = doors.map(door => walkFrom([door]).between(place, stop).meters)

      const walks = walkFrom(doors)
      const walk = walks.between(place, stop)
      for (const meters of byEach)
        expect(walk.meters).toBeLessThanOrEqual(meters + 1e-6)
      expect(walk.meters).toBeCloseTo(Math.min(...byEach), 6)
      expect(doors).toContainEqual(walk.coordinates[0])
      expect(walk.coordinates.at(-1)).toEqual([stopLon, stopLat])
      // The same either way, and to stops alike
      expect(walks.between(stop, place).meters).toBeCloseTo(walk.meters, 3)
      const { meters: [toStop] } = walks.toStops(place)
      expect(toStop).toEqual(walk.meters <= 2000 ? expect.closeTo(walk.meters, 6) : Infinity)
    }
  ))
)

test("a place is walked from the doors of the building it's in or named for, but a stop in one from itself", () =>
  fc.assert(fc.property(doorsAndStop, spot, ({ graph, doors: [door], stop: [stopLon, stopLat] }, [lon, lat]) => {
    const stop = { lat: stopLat, lon: stopLon, name: "Hall" }
    const walks = createWalks([stop], graph, [buildingAround([lon, lat], [door]), buildingAround([stopLon, stopLat], [door], "Stop Hall")])
    expect(walks.between({ lat, lon }, stop).coordinates[0]).toEqual(door)
    expect(walks.between({ lat: lat + 1, lon, name: "Hall" }, stop).coordinates[0]).toEqual(door)
    expect(walks.between({ lat: stopLat, lon: stopLon }, { lat, lon }).coordinates[0]).toEqual(door)
    expect(walks.between(stop, { lat, lon }).coordinates[0]).toEqual([stopLon, stopLat])
  }))
)

test("the network leaves out ways closed to walkers, and paths nothing else reaches", () => {
  const node = (id: number, lon: number): OsmElement => ({ type: "node", id, lat: CENTER.lat, lon: CENTER.lon + lon * 1e-4 })
  const way = (id: number, nodes: number[], tags: Record<string, string>): OsmElement => ({ type: "way", id, nodes, tags })
  const data = walkGraph([
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(id => node(id, id)),
    way(1, [1, 2, 3], { highway: "footway" }),
    way(2, [3, 4], { highway: "residential", access: "private" }),
    way(3, [3, 5], { highway: "service", access: "private", foot: "yes" }),
    way(4, [5, 6], { highway: "motorway" }),
    way(5, [7, 8], { highway: "footway" }),
    // A path with a node missing from the extract, which isn't joined up across the gap
    way(6, [8, 99, 9], { highway: "footway" })
  ], 2)
  const graph = loadGraph(data)
  // Nodes 1 to 3 and on to 5: the private road is closed, the private drive allows walkers, and the islands are dropped
  expect(graph.lines.length).toBe(2)
  expect(graph.offsets.length - 1).toBe(3)
  expect(graph.lines.map(line => line.length)).toEqual([2, 2].map(steps => expect.closeTo(steps * 1e-4 * ruler(CENTER.lat).kx, 0)))
})
