// GTFS tables -> the compact FeedData the app loads

import { parse as parseCsv } from "csv-parse/sync"
import { ColorSpace, contrastWCAG21, parse, sRGB } from "colorjs.io/fn"
import { alongSegment, angleBetween, type Coordinates } from "../../src/map/geometry.mts"
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

// Degrees to about a meter for stops, and a decimeter for shapes, finer than the curves drawn along them
const round = (x: number, digits = 5) => Math.round(x * 10 ** digits) / 10 ** digits

// Shapes are traced from GPS, wobbling a meter or two either way every 10 m or so, which draws as a jagged line
// and turns buses at every wobble. Wobbles within this are dropped, then each corner left is rounded off over up to
// CORNER either side of it, so a straight street stays straight however far apart its points are
const WOBBLE = 4    // m
const CORNER = 15   // m, about a bus's turning radius
const TURN_STEP = 6 // degrees a rounded corner turns between the points drawn along it
const MIN_STEP = 2  // m, unless they'd be closer than this, as rounding would then turn them more

type Meters = [number, number]

const length = (p: Meters, q: Meters) => Math.hypot(q[0] - p[0], q[1] - p[1])
const heading = (p: Meters, q: Meters) => Math.atan2(q[0] - p[0], q[1] - p[1]) * 180 / Math.PI

/** The point some meters from p toward q */
const toward = (p: Meters, q: Meters, meters: number): Meters => {
  const t = meters / length(p, q)
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
}

/** Meters east and north of a point and back, flat-earth, fine at city scale */
const metersFrom = (origin: Coordinates) => {
  const x = 111_320 * Math.cos(origin[1] * Math.PI / 180)
  return {
    to: ([lon, lat]: Coordinates): Meters => [(lon - origin[0]) * x, (lat - origin[1]) * 110_540],
    from: ([east, north]: Meters): Coordinates => [origin[0] + east / x, origin[1] + north / 110_540]
  }
}

/** Ramer–Douglas–Peucker: the fewest points that stay within a tolerance of the line through all of them */
const simplify = (points: Meters[], tolerance: number): Meters[] => {
  const keep = new Set([0, points.length - 1])
  const split = (first: number, last: number) => {
    const [a, b] = [points[first], points[last]]
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
    let [farthest, worst] = [-1, tolerance]
    for (let i = first + 1; i < last; i++) {
      const [px, py] = [points[i][0] - a[0], points[i][1] - a[1]]
      // From the segment rather than the line through it, so a stretch that doubles back on itself is kept
      const t = alongSegment(px, py, dx, dy)
      const d = Math.hypot(px - t * dx, py - t * dy)
      if (d > worst)
        [farthest, worst] = [i, d]
    }
    if (farthest === -1)
      return
    keep.add(farthest)
    split(first, farthest)
    split(farthest, last)
  }
  split(0, points.length - 1)
  return points.filter((_, i) => keep.has(i))
}

/** A shape with its GPS wobble dropped and its corners rounded, with a point every few degrees of turning */
export const smoothShape = (shape: Coordinates[]) => {
  const meters = metersFrom(shape[0])
  const points = simplify(shape.map(meters.to), WOBBLE)
  const smooth: Meters[] = [points[0]]
  for (let i = 1; i + 1 < points.length; i++) {
    const [a, corner, b] = [points[i - 1], points[i], points[i + 1]]
    // Up to halfway along each side, so neighboring corners meet at most, each curve leaving along the side
    const cut = Math.min(CORNER, length(a, corner) / 2, length(corner, b) / 2)
    const [start, end] = [toward(corner, a, cut), toward(corner, b, cut)]
    const steps = Math.max(1, Math.min(
      Math.ceil(angleBetween(heading(a, corner), heading(corner, b)) / TURN_STEP),
      Math.floor(2 * cut / MIN_STEP)
    ))
    // A quadratic Bézier with the corner as its control point
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const [u, v, w] = [(1 - t) ** 2, 2 * (1 - t) * t, t ** 2]
      smooth.push([u * start[0] + v * corner[0] + w * end[0], u * start[1] + v * corner[1] + w * end[1]])
    }
  }
  if (points.length > 1)
    smooth.push(points.at(-1)!)
  // Two corners cut to meet halfway along a short side both put a point there, and points much closer than a meter
  // would round to one
  const isEnd = (i: number) => i === 0 || i === smooth.length - 1
  return smooth.filter((point, i) => isEnd(i) || length(point, smooth[i - 1]) > 0.5).map(meters.from)
}

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
    shapes[id] = smoothShape(
      points
        .sort((a, b) => +a.shape_pt_sequence - +b.shape_pt_sequence)
        .map((point): Coordinates => [+point.shape_pt_lon, +point.shape_pt_lat])
    ).map(([lon, lat]) => [round(lon, 6), round(lat, 6)])

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
