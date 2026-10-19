// Walking: how far it is and which way, along Durham's streets and paths where the walking network joins both
// ends, from a building's nearest door where the gazetteer knows its doors, and otherwise an estimate: a straight
// line a quarter longer, which the map draws as the guess it is

import { type Following, follow } from "../geo/follow.mts"
import type { Line } from "../geo/lines.mts"
import { type Coordinates, type Point, distance } from "../geo/projection.mts"
import { type Anchor, type Graph, type Reach, anchors, componentOf, metersTo, pathTo, reach } from "./graph.mts"
import { type GazetteerPlace, buildingsAt } from "./gazetteer.mts"
import type { Fix } from "./fixes.mts"

const WALK_SPEED = 1.3                // m/s
const WALK_WIGGLE = 0.1               // a walk may take this much longer: a slow day, or a longer way round
export const MAX_ACCESS_WALK = 2000   // m walked, to the first stop or from the last
export const MAX_TRANSFER_WALK = 500  // m walked, between stops
/** Streets wind this much more than the straight line between two places */
export const STREET_DETOUR = 1.25
/** Further than this from every path, a place is off the network, and walked to in a straight line */
const MAX_SNAP = 250 // m
/** How many of the paths nearest a place it may join the network by, as the nearest isn't always the way in */
const WAYS_IN = 3

type Named = Point & { name?: string }

export const walkSeconds = (meters: number) =>
  Math.round(meters / WALK_SPEED)

/** How long to allow for a walk, for a slow day or a longer way round */
export const walkAllowance = (meters: number) =>
  Math.round(walkSeconds(meters) * (1 + WALK_WIGGLE))

/** How far it is to walk in a straight line, allowing for the streets winding */
export const straightMeters = (from: Point, to: Point) =>
  distance(from, to) * STREET_DETOUR

export type Walk = {
  meters: number,
  coordinates: Coordinates[],
  /** Along the network, or a straight line's estimate where the network doesn't join the two */
  via: "network" | "estimate"
}

export type Walks = {
  /** Meters walked from a place to each stop, or Infinity beyond MAX_ACCESS_WALK, the same either way */
  toStops: (place: Named) => Float64Array,
  /** For each stop, the others within MAX_TRANSFER_WALK and the meters walked to each */
  transfers: () => [number, number][][],
  /** How far it is from one place to another, and which way */
  between: (from: Named, to: Named) => Walk
}

/**
 * The places a place is walked to or from: the doors of the building it's in or named for, where the gazetteer
 * knows them, else the place itself
 */
const doorsOf = (places: readonly GazetteerPlace[], place: Named): Point[] => {
  const building =
    buildingsAt(places, place)[0] ??
    places.find(({ kind, name }) => kind === "building" && name === place.name)
  return building?.entrances?.map(([lon, lat]) => ({ lat, lon })) ?? [place]
}

const straight = (from: Point, to: Point): Walk =>
  ({ meters: straightMeters(from, to), coordinates: [[from.lon, from.lat], [to.lon, to.lat]], via: "estimate" })

/** Walking among some stops, along a network where one joins them, to and from the doors of the gazetteer's buildings */
export const createWalks = (stops: Named[], graph?: Graph, places: readonly GazetteerPlace[] = []): Walks => {
  // Places and stops are the same objects each time they're planned from, so what's found for each is kept. A stop
  // is where the bus stops, rather than a building it's beside
  const isStop = new Set(stops)
  const anchorsCache = new WeakMap<Named, Anchor[]>()
  const anchorsOf = (place: Named) => {
    let found = anchorsCache.get(place)
    if (!found) {
      found = graph ? (isStop.has(place) ? [place] : doorsOf(places, place)).flatMap(door => anchors(graph, door, MAX_SNAP, WAYS_IN)) : []
      anchorsCache.set(place, found)
    }
    return found
  }
  /** Whether the network joins two places: some part of it has an anchor of each */
  const joins = (from: Anchor[], to: Anchor[]) =>
    from.some(a => to.some(b => componentOf(graph!, a) === componentOf(graph!, b)))
  const reaches = new WeakMap<Named, { limit: number, reached: Reach }>()
  /** Everywhere a place reaches on the network, up to a limit, found again further if a later question asks */
  const reachOf = (place: Named, limit: number) => {
    const known = reaches.get(place)
    if (known && known.limit >= limit)
      return known.reached
    const reached = reach(graph!, anchorsOf(place), limit)
    reaches.set(place, { limit, reached })
    return reached
  }
  /** The nearest of some anchors along the network, and the meters walked to it */
  const nearest = (reached: Reach, to: Anchor[]) =>
    to
      .map(anchor => ({ anchor, meters: metersTo(graph!, reached, anchor) }))
      .reduce((a, b) => b.meters < a.meters ? b : a)

  const toStopsCache = new WeakMap<Named, Float64Array>()
  const metersToStops = (place: Named, limit: number) => {
    const from = anchorsOf(place)
    const reached = from.length ? reachOf(place, limit) : undefined
    return Float64Array.from(stops, stop => {
      const to = anchorsOf(stop)
      const meters = reached && joins(from, to) ? nearest(reached, to).meters : straightMeters(place, stop)
      return meters <= limit ? meters : Infinity
    })
  }

  let transfers: [number, number][][] | undefined

  return {
    toStops: place => {
      let meters = toStopsCache.get(place)
      if (!meters)
        toStopsCache.set(place, meters = metersToStops(place, MAX_ACCESS_WALK))
      return meters
    },
    transfers: () =>
      transfers ??= stops.map((stop, i) =>
        [...metersToStops(stop, MAX_TRANSFER_WALK)]
          .flatMap((meters, j): [number, number][] => i !== j && meters < Infinity ? [[j, meters]] : [])
      ),
    between: (from, to) => {
      const ends = anchorsOf(to)
      if (!joins(anchorsOf(from), ends))
        return straight(from, to)
      const reached = reachOf(from, Infinity)
      const { anchor, meters } = nearest(reached, ends)
      return { meters, coordinates: pathTo(graph!, reached, anchor), via: "network" }
    }
  }
}

// Further than this from a walk, or than a fix's own accuracy where that's worse, you're off it
const ON_PATH = 25 // m
// Brisker than a walk, short of a run, so a fix much further along has found some other stretch of the walk
const MAX_WALK_SPEED = 3 // m/s
// Fixes in a row off a walk that mean you've left it, rather than GPS wandering for a moment
const OFF_PATH = 3

/** How far along a walk you've got */
export type Progress = {
  line: Line,
  /** Where the last fix on the walk put you, which the next follows on from */
  last?: Following,
  /** Meters along the walk you've got to, which GPS wandering back doesn't undo */
  distance: number,
  /** Fixes in a row off the walk */
  missed: number
}

/** How far along a walk a fix puts you, on from where you'd got along it, or from its start on another */
export const walkOn = (line: Line, fix: Fix, previous?: Progress): Progress => {
  const before = previous?.line === line ? previous : undefined
  const followed = follow([line], fix, before?.last, { within: Math.max(ON_PATH, fix.accuracy), speed: MAX_WALK_SPEED })
  return followed
    ? { line, last: followed, distance: Math.max(before?.distance ?? 0, followed.distance), missed: 0 }
    : { line, last: before?.last, distance: before?.distance ?? 0, missed: (before?.missed ?? 0) + 1 }
}

/** Off the walk for long enough that you've left it, and want a new way from where you are */
export const isOffPath = ({ missed }: Progress) =>
  missed >= OFF_PATH
