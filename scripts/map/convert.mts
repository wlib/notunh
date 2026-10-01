// GTFS tables -> the compact FeedData the app loads

import { parse as parseCsv } from "csv-parse/sync"
import { ColorSpace, contrastWCAG21, parse, sRGB } from "colorjs.io/fn"
import { distance, type FeedData, type Route, type Service, type Stop, type Trip } from "../../src/map/feed.mts"

ColorSpace.register(sRGB)

export type Row = Record<string, string>

/** A GTFS table's rows, by column name */
export const parseTable = (text: string): Row[] =>
  parseCsv(text, {
    columns: true,
    bom: true,
    trim: true,
    skip_empty_lines: true,
    skip_records_with_empty_values: true,
    relax_column_count: true
  })

export const parseTime = (time: string) => {
  if (!time)
    return undefined
  const [h, m, s] = time.split(":").map(Number)
  return h * 3600 + m * 60 + s
}

/**
 * Fills in missing times (non-timepoints) proportionally to distance travelled between known ones.
 * Leading and trailing gaps copy the nearest known time
 */
export const interpolateTimes = (known: (number | undefined)[], along: number[]) => {
  const times = known.slice()
  const knownPositions = known.flatMap((time, i) => time === undefined ? [] : [i])
  if (!knownPositions.length)
    return times.map(() => 0)

  for (let i = 0; i < knownPositions[0]; i++)
    times[i] = known[knownPositions[0]]
  for (let i = knownPositions.at(-1)! + 1; i < times.length; i++)
    times[i] = known[knownPositions.at(-1)!]

  for (let k = 0; k + 1 < knownPositions.length; k++) {
    const a = knownPositions[k]
    const b = knownPositions[k + 1]
    const span = along[b] - along[a]
    for (let j = a + 1; j < b; j++) {
      const fraction = span ? (along[j] - along[a]) / span : (j - a) / (b - a)
      times[j] = Math.round(known[a]! + fraction * (known[b]! - known[a]!))
    }
  }
  return times as number[]
}

/** GTFS's text color, unless it isn't readable on the route color as small text (WCAG 2.1 AA) */
export const readableText = (color: string, text: string) => {
  const background = parse(color)
  const contrast = (foreground: string) => contrastWCAG21(background, parse(foreground))
  return (
    contrast(text) >= 4.5                     ? text :
    contrast("#000000") > contrast("#ffffff") ? "#000000" :
                                                "#ffffff"
  )
}

const round = (x: number) => Math.round(x * 1e5) / 1e5

const DAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

const groupBy = <T,>(items: T[], key: (item: T) => string) => {
  const groups = new Map<string, T[]>()
  for (const item of items)
    groups.set(key(item), [...groups.get(key(item)) ?? [], item])
  return groups
}

export const convert = (table: (name: string) => Row[]): FeedData => {
  const [feedInfo] = table("feed_info.txt")

  const routes: Route[] = table("routes.txt").map(route => {
    const color = route.route_color || "555555"
    return {
      id:    route.route_id,
      name:  route.route_short_name || route.route_long_name,
      long:  route.route_long_name,
      color: "#" + color,
      text:  readableText("#" + color, "#" + (route.route_text_color || "FFFFFF"))
    }
  })

  const services: Record<string, Service> = {}
  for (const service of table("calendar.txt"))
    services[service.service_id] = {
      days: DAY_COLUMNS.reduce((days, day, i) => days | (service[day] === "1" ? 1 << i : 0), 0),
      start: +service.start_date,
      end:   +service.end_date,
      added:   [],
      removed: []
    }
  for (const exception of table("calendar_dates.txt")) {
    const service = services[exception.service_id] ??= { days: 0, start: 0, end: 0, added: [], removed: [] }
    if (exception.exception_type === "1")
      service.added.push(+exception.date)
    else
      service.removed.push(+exception.date)
  }

  const stopTimesByTrip = groupBy(table("stop_times.txt"), stopTime => stopTime.trip_id)
  for (const stopTimes of stopTimesByTrip.values())
    stopTimes.sort((a, b) => +a.stop_sequence - +b.stop_sequence)

  // Only keep stops some trip visits, and note the ones nobody can board at
  // (a trip's last stop never counts as a boarding)
  const boardable = new Set<string>()
  const visited = new Set<string>()
  for (const stopTimes of stopTimesByTrip.values())
    stopTimes.forEach((stopTime, i) => {
      visited.add(stopTime.stop_id)
      if (i + 1 < stopTimes.length && stopTime.pickup_type !== "1")
        boardable.add(stopTime.stop_id)
    })

  const stops: Stop[] = table("stops.txt")
    .filter(stop => visited.has(stop.stop_id))
    .map(stop => ({
      id:   stop.stop_id,
      name: stop.stop_name.replace(/\s+/g, " "),
      lat:  round(+stop.stop_lat),
      lon:  round(+stop.stop_lon),
      ...boardable.has(stop.stop_id) ? {} : { pickup: false as const }
    }))
  const stopIndex = new Map(stops.map((stop, i) => [stop.id, i]))

  const trips: Trip[] = table("trips.txt").map(trip => {
    const stopTimes = stopTimesByTrip.get(trip.trip_id) ?? []
    const tripStops = stopTimes.map(stopTime => stopIndex.get(stopTime.stop_id)!)

    const along = [0]
    for (let i = 1; i < tripStops.length; i++)
      along.push(along[i - 1] + distance(stops[tripStops[i - 1]], stops[tripStops[i]]))

    return {
      id:       trip.trip_id,
      route:    trip.route_id,
      service:  trip.service_id,
      headsign: trip.trip_headsign,
      shape:    trip.shape_id,
      stops:    tripStops,
      times:    interpolateTimes(
        stopTimes.map(stopTime => parseTime(stopTime.departure_time || stopTime.arrival_time)),
        along
      )
    }
  })

  const shapes: Record<string, [number, number][]> = {}
  for (const [id, points] of groupBy(table("shapes.txt"), point => point.shape_id))
    shapes[id] = points
      .sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence)
      .map(point => [round(+point.shape_pt_lon), round(+point.shape_pt_lat)])

  return {
    version: feedInfo?.feed_version ?? "",
    start:   +(feedInfo?.feed_start_date ?? 0),
    end:     +(feedInfo?.feed_end_date ?? 0),
    routes,
    stops,
    services,
    trips,
    shapes
  }
}
