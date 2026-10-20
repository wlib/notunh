// Walking: how far it is and which way, along Durham's streets and paths where the walking network joins both
// ends, from a building's nearest door where the gazetteer knows its doors, and otherwise an estimate: a straight
// line a quarter longer, which the map draws as the guess it is

import { type Following, type Tracking, follow } from "../geo/follow.mts"
import type { Line } from "../geo/lines.mts"
import { type Coordinates, type Point, straightMeters } from "../geo/projection.mts"
import { type Anchor, type Graph, type Reach, anchors, componentOf, metersTo, pathTo, reach } from "./graph.mts"
import { type GazetteerPlace, buildingsAt } from "../places/gazetteer.mts"
import type { Fix } from "../geo/fixes.mts"

const WALK_SPEED = 1.3                // m/s
const WALK_WIGGLE = 0.1               // a walk along the network may take this much longer: a slow day, or a longer way round
const ESTIMATE_WIGGLE = 0.3           // an estimate may take this much longer, as the way round what's between is anyone's guess
export const MAX_ACCESS_WALK = 2000   // m walked, to the first stop or from the last
export const MAX_TRANSFER_WALK = 500  // m walked, between stops
/** Further than this from every path, a place is off the network, and walked to in a straight line */
const MAX_SNAP = 250 // m
/** How many of the paths nearest a place it may join the network by, as the nearest isn't always the way in */
const WAYS_IN = 3

type Named = Point & { name?: string }

export const walkSeconds = (meters: number) =>
  Math.round(meters / WALK_SPEED)

/** How a walk is known: along the network, or a straight line's estimate where the network doesn't join its ends */
export type Via = "network" | "estimate"

/** How long to allow for a walk, for a slow day or a longer way round, and more for an estimate, which may be a longer way round indeed */
export const walkAllowance = (meters: number, via: Via) =>
  Math.round(walkSeconds(meters) * (1 + (via === "estimate" ? ESTIMATE_WIGGLE : WALK_WIGGLE)))

export type Walk = {
  meters: number,
  coordinates: Coordinates[],
  via: Via
}

/** The walks from a place to every stop at once: meters walked to each, or Infinity beyond a limit, and how each is known */
export type Reaches = { meters: Float64Array, via: Via[] }

/** A walk from one stop to another, by its index */
export type Transfer = { to: number, meters: number, via: Via }

export type Walks = {
  /** The walks from a place to each stop, up to MAX_ACCESS_WALK, the same either way */
  toStops: (place: Named) => Reaches,
  /** For each stop, the walks to the others within MAX_TRANSFER_WALK */
  transfers: () => Transfer[][],
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

  const toStopsCache = new WeakMap<Named, Reaches>()
  const reachesOf = (place: Named, limit: number): Reaches => {
    const from = anchorsOf(place)
    const reached = from.length ? reachOf(place, limit) : undefined
    const via = stops.map((stop): Via => reached && joins(from, anchorsOf(stop)) ? "network" : "estimate")
    const meters = Float64Array.from(stops, (stop, i) => {
      const walked = via[i] === "network" ? nearest(reached!, anchorsOf(stop)).meters : straightMeters(place, stop)
      return walked <= limit ? walked : Infinity
    })
    return { meters, via }
  }

  let transfers: Transfer[][] | undefined

  return {
    toStops: place => {
      let reaches = toStopsCache.get(place)
      if (!reaches)
        toStopsCache.set(place, reaches = reachesOf(place, MAX_ACCESS_WALK))
      return reaches
    },
    transfers: () =>
      transfers ??= stops.map((stop, i) => {
        const { meters, via } = reachesOf(stop, MAX_TRANSFER_WALK)
        return [...meters].flatMap((walked, to): Transfer[] => i !== to && walked < Infinity ? [{ to, meters: walked, via: via[to] }] : [])
      }),
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

/** How a walker keeps to the walk: within a street's width of it, heading along it, and a few fixes' walking on from where they were */
const WALKER_TRACKING: Tracking = {
  snap:      60,
  heading:   50,
  back:      30,
  // Between fixes, a few seconds apart, not even a run gets further than this
  ahead:     100,
  switching: 25,
  leeway:    30,
  maxSkip:   30_000
}

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
  const followed = follow([line], fix, before?.last, { ...WALKER_TRACKING, within: Math.max(ON_PATH, fix.accuracy), speed: MAX_WALK_SPEED })
  return followed
    ? { line, last: followed, distance: Math.max(before?.distance ?? 0, followed.distance), missed: 0 }
    : { line, last: before?.last, distance: before?.distance ?? 0, missed: (before?.missed ?? 0) + 1 }
}

/** Off the walk for long enough that you've left it, and want a new way from where you are */
export const isOffPath = ({ missed }: Progress) =>
  missed >= OFF_PATH
