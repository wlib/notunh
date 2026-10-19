// The street geometry of the timetable: each route's shapes as lines with the stops of its trips along them, which
// buses are followed along and rides are drawn along

import { type Line, positionsAlong, sliceLine, toLine } from "../geo/lines.mts"
import type { Coordinates } from "../geo/projection.mts"
import type { Feed, Trip } from "./feed.mts"
import type { RideLeg } from "./plan.mts"

/** A shape with the stops of the trips along it */
export type RouteLine = Line & {
  /** Each stop the line's trips serve, by meters from the start, ascending */
  stops: { id: string, distance: number }[],
  /** The route whose trips follow it */
  route: string
}

// A loop's trips end at the stop they start from, which driving on around the loop already comes back to
const LOOP_GAP = 30 // m

/** A shape and the stops of each trip along it */
export const toRouteLine = (route: string, coordinates: Coordinates[], trips: { id: string, lat: number, lon: number }[][]): RouteLine => {
  const line = toLine(coordinates)
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

const tripPositions = new WeakMap<Trip, number[]>()

/** The street geometry a ride follows, from its boarding stop to where it gets off */
export const ridePath = (feed: Feed, leg: RideLeg): Coordinates[] => {
  const { trip } = leg.run
  const [first, last] = [leg.fromPosition, leg.toPosition]
    .map(position => feed.stops[trip.stops[position]])
    .map(({ lon, lat }): Coordinates => [lon, lat])
  const line = routeLines(feed).get(trip.route)?.find(line => line.coordinates === feed.shapes[trip.shape])
  if (!line)
    return [first, last]

  let positions = tripPositions.get(trip)
  if (!positions)
    tripPositions.set(trip, positions = positionsAlong(line, trip.stops.map(stop => feed.stops[stop])))
  // The line between the two stops, from one to the other rather than from where each projects onto it
  return [first, ...sliceLine(line, positions[leg.fromPosition], positions[leg.toPosition]).slice(1, -1), last]
}
