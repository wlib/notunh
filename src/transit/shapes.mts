// The street geometry of the timetable: each route's shapes as lines with the stops of its trips along them, which
// buses are followed along and rides are drawn along

import type { Tracking } from "../geo/follow.mts"
import { type Line, positionsAlong, sliceLine, toLine } from "../geo/lines.mts"
import { type Coordinates, segmentMeters } from "../geo/projection.mts"
import type { Feed, Trip } from "./feed.mts"

/** A shape with the stops of the trips along it */
export type RouteLine = Line & {
  /** Each stop the line's trips serve, by meters from the start, ascending */
  stops: { id: string, distance: number }[],
  /** The route whose trips follow it */
  route: string
}

// A shape ending this close to where it starts is a loop: its buses drive on around it, and its trips end at the
// stop they start from, which driving on around already comes back to
export const LOOP_GAP = 30 // m

/** How a bus keeps to its route's shapes: within the street's width of one, the way it's heading, and on along the pass it was on */
export const BUS_TRACKING: Tracking = {
  // Further off every shape, it's on a detour or at the depot
  snap:      60,
  heading:   50,
  // Between fixes, GPS jitters back a little, and a bus gets no further than a few blocks on
  back:      30,
  ahead:     300,
  switching: 25,
  leeway:    30,
  maxSkip:   30_000
}

/** A shape and the stops of each trip along it */
export const toRouteLine = (route: string, coordinates: Coordinates[], trips: { id: string, lat: number, lon: number }[][]): RouteLine => {
  const line = toLine(coordinates, coordinates.length > 2 && segmentMeters(coordinates[0], coordinates.at(-1)!) < LOOP_GAP)
  const stops = [
    ...new Map(trips.flatMap(stops =>
      positionsAlong(line, stops).map((distance, i) => {
        const stop = { id: stops[i].id, distance }
        return [`${stop.id}@${stop.distance}`, stop] as const
      })
    )).values()
  ].sort((a, b) => a.distance - b.distance)
  return {
    ...line,
    route,
    stops: line.isLoop
      ? stops.filter(stop => line.length - stop.distance >= LOOP_GAP || !stops.some(other => other.id === stop.id && other.distance < LOOP_GAP))
      : stops
  }
}

/** Meters along a line of the stop at an index counting on around a loop, or ±Infinity off either end of one that isn't */
export const stopDistance = (line: RouteLine, index: number) => {
  const n = line.stops.length
  if (!line.isLoop && (index < 0 || index >= n) || !n)
    return index < 0 ? -Infinity : Infinity
  const lap = Math.floor(index / n)
  return line.stops[index - lap * n].distance + lap * line.length
}

export const stopId = (line: RouteLine, index: number) =>
  line.stops[((index % line.stops.length) + line.stops.length) % line.stops.length].id

/** The index of the first stop past a distance along a line, counting on around a loop */
export const stopAhead = (line: RouteLine, distance: number) => {
  const n = line.stops.length
  const lap = line.isLoop ? Math.floor(distance / line.length) : 0
  const offset = distance - lap * line.length
  let [low, high] = [0, n]
  while (low < high) {
    const middle = (low + high) >> 1
    if (line.stops[middle].distance > offset)
      high = middle
    else
      low = middle + 1
  }
  return lap * n + low
}

const linesCache = new WeakMap<Feed, Map<string, RouteLine[]>>()

/** Each route's lines: one per shape its trips follow, with those trips' stops along it */
export const routeLines = (feed: Feed) => {
  let lines = linesCache.get(feed)
  if (!lines) {
    lines = new Map(feed.routes.map(route => {
      const trips = feed.trips.filter(trip => trip.route === route.id)
      return [
        route.id,
        [...new Set(trips.map(trip => trip.shape))].map(shape => toRouteLine(
          route.id,
          feed.shapes[shape],
          trips
            .filter(trip => trip.shape === shape)
            .map(trip => trip.stops.map(stop => feed.stops[stop]))
        ))
      ]
    }))
    linesCache.set(feed, lines)
  }
  return lines
}

/** The line a trip follows, if its route has its shape */
export const lineOf = (feed: Feed, trip: Trip) =>
  feed.shapes[trip.shape] && routeLines(feed).get(trip.route)?.find(line => line.coordinates === feed.shapes[trip.shape])

const tripPositions = new WeakMap<Trip, number[] | undefined>()

/** Meters along its line each of a trip's stops is at, if its route has its shape */
export const positionsOf = (feed: Feed, trip: Trip) => {
  if (!tripPositions.has(trip)) {
    const line = lineOf(feed, trip)
    tripPositions.set(trip, line && positionsAlong(line, trip.stops.map(stop => feed.stops[stop])))
  }
  return tripPositions.get(trip)
}

/** The street geometry a ride follows, from its boarding stop to where it gets off, by their positions in its trip */
export const ridePath = (feed: Feed, leg: { run: { trip: Trip }, fromPosition: number, toPosition: number }): Coordinates[] => {
  const { trip } = leg.run
  const [first, last] = [leg.fromPosition, leg.toPosition]
    .map(position => feed.stops[trip.stops[position]])
    .map(({ lon, lat }): Coordinates => [lon, lat])
  const line = lineOf(feed, trip)
  const positions = positionsOf(feed, trip)
  if (!line || !positions)
    return [first, last]
  // The line between the two stops, from one to the other rather than from where each projects onto it
  return [first, ...sliceLine(line, positions[leg.fromPosition], positions[leg.toPosition]).slice(1, -1), last]
}
