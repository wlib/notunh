import { test, expect } from "vitest"
import fc from "fast-check"
import { ColorSpace, contrastWCAG21, parse, sRGB } from "colorjs.io/fn"
import { type Correction, type Row, CORRECTIONS, convert, interpolateTimes, parseTable, readableText, smoothShape } from "../../scripts/map/convert.mts"
import { alongSegment } from "../../src/geo/lines.mts"
import { type Coordinates, ruler } from "../../src/geo/projection.mts"

ColorSpace.register(sRGB)

test("parseTable reads GTFS's quirks: a byte order mark, quoted fields, padding, and blank rows", () => {
  const text = "\uFEFFroute_id, route_long_name ,route_color\r\n1,\"Dover, NH\",FF6600\r\n,,\r\n2,\"Say \"\"hi\"\"\",\r\n"
  expect(parseTable(text)).toEqual([
    { route_id: "1", route_long_name: "Dover, NH", route_color: "FF6600" },
    { route_id: "2", route_long_name: "Say \"hi\"", route_color: "" }
  ])
})

const knownTimes = fc
  .array(fc.option(fc.nat({ max: 600 }), { nil: undefined }), { minLength: 1, maxLength: 20 })
  .chain(steps =>
    fc.tuple(
      fc.constant(steps),
      fc.array(fc.nat({ max: 2000 }), { minLength: steps.length, maxLength: steps.length })
    )
  )
  .map(([steps, gaps]) => {
    // Running sums so known times and distances only ever increase
    let time = 0
    let along = 0
    return {
      known: steps.map(step => step === undefined ? undefined : time += step),
      along: gaps.map((gap, i) => i === 0 ? 0 : along += gap)
    }
  })

test("interpolateTimes keeps known times and fills the rest in order", () =>
  fc.assert(fc.property(knownTimes, ({ known, along }) => {
    const times = interpolateTimes(known, along)

    expect(times).toHaveLength(known.length)
    known.forEach((time, i) => {
      if (time !== undefined)
        expect(times[i]).toBe(time)
    })
    if (known.some(time => time !== undefined))
      for (let i = 1; i < times.length; i++)
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
  }))
)

test("interpolateTimes is proportional to distance between timepoints", () => {
  expect(interpolateTimes([0, undefined, undefined, 300], [0, 100, 300, 300])).toEqual([0, 100, 300, 300])
  expect(interpolateTimes([undefined, 60, undefined], [0, 0, 50])).toEqual([60, 60, 60])
})

const hex = fc.integer({ min: 0, max: 0xFFFFFF }).map(n => "#" + n.toString(16).padStart(6, "0"))

test("readableText keeps a readable GTFS color, otherwise picks whichever of black and white reads better", () =>
  fc.assert(fc.property(hex, hex, (color, text) => {
    const contrast = (foreground: string) => contrastWCAG21(parse(color), parse(foreground))
    const chosen = readableText(color, text)
    if (contrast(text) >= 4.5)
      expect(chosen).toBe(text)
    else
      expect(contrast(chosen)).toBe(Math.max(contrast("#000000"), contrast("#ffffff")))
  }))
)

const { kx: EAST, ky: NORTH } = ruler(43.135)

/** Meters east and north of one point from another, flat around Durham */
const offset = ([lon, lat]: Coordinates, [x, y]: Coordinates) => [(x - lon) * EAST, (y - lat) * NORTH]

const metersApart = (a: Coordinates, b: Coordinates) => Math.hypot(...offset(a, b))

/** Meters from a point to the nearest point of a polyline */
const offLine = (point: Coordinates, line: Coordinates[]) => {
  let nearest = Infinity
  for (let i = 0; i + 1 < line.length; i++) {
    const [[ax, ay], [bx, by]] = [offset(point, line[i]), offset(point, line[i + 1])]
    const [dx, dy] = [bx - ax, by - ay]
    const t = alongSegment(-ax, -ay, dx, dy)
    nearest = Math.min(nearest, Math.hypot(ax + t * dx, ay + t * dy))
  }
  return nearest
}

/** A point some meters from another along a heading in radians */
const stepFrom = ([lon, lat]: Coordinates, radians: number, meters: number): Coordinates =>
  [lon + Math.sin(radians) * meters / EAST, lat + Math.cos(radians) * meters / NORTH]

// A street wandering about Durham: steps of 5 to 60 m, in any direction, with GPS wobble
const shapes = fc
  .array(fc.tuple(fc.double({ min: 5, max: 60, noNaN: true }), fc.double({ min: 0, max: 2 * Math.PI, noNaN: true })), { minLength: 1, maxLength: 30 })
  .map(steps => steps.reduce<Coordinates[]>((points, [meters, angle]) => [...points, stepFrom(points.at(-1)!, angle, meters)], [[-70.93, 43.135]]))

test("smoothShape keeps the ends and stays on the street, within a few meters of the shape either way", () => {
  fc.assert(fc.property(shapes, shape => {
    const smooth = smoothShape(shape)
    expect(smooth[0]).toEqual(shape[0])
    expect(smooth.at(-1)).toEqual(shape.at(-1))
    smooth.slice(1).forEach((point, i) => expect(metersApart(point, smooth[i])).toBeGreaterThan(0))
    // Dropped wobbles and cut corners, at most a few meters each
    for (const point of smooth)
      expect(offLine(point, shape)).toBeLessThan(9)
    for (const point of shape)
      expect(offLine(point, smooth)).toBeLessThan(9)
  }))
})

test("smoothShape keeps straight streets straight, rounding off only their corner", () =>
  fc.assert(fc.property(
    fc.double({ min: 0, max: 360, noNaN: true }),
    fc.double({ min: 20, max: 160, noNaN: true }),
    fc.array(fc.double({ min: 5, max: 150, noNaN: true }), { minLength: 1, maxLength: 6 }),
    fc.array(fc.double({ min: 5, max: 150, noNaN: true }), { minLength: 1, maxLength: 6 }),
    (heading, turn, before, after) => {
      // Two straight streets meeting at a corner, with their points however far apart
      const walk = (from: Coordinates, degrees: number, steps: number[]) =>
        steps.reduce<Coordinates[]>((points, meters) => [...points, stepFrom(points.at(-1)!, degrees * Math.PI / 180, meters)], [from])
      const first = walk([-70.93, 43.135], heading, before)
      const corner = first.at(-1)!
      const shape = [...first, ...walk(corner, heading + turn, after).slice(1)]
      // Off by no more than a dropped wobble, as a slight enough corner is one, give or take this test's flatter earth
      for (const point of smoothShape(shape))
        if (metersApart(point, corner) > 15)
          expect(offLine(point, shape)).toBeLessThan(4.1)
    }
  ))
)

/** A GTFS feed of one trip of a route along stops, with whatever each stop time says besides its times */
const tables = (stopTimes: Row[], { route = "R", stops = ["a", "b", "c"], corrections }: { route?: string, stops?: string[], corrections?: Correction[] } = {}) => {
  const rows: Record<string, Row[]> = {
    "feed_info.txt":      [{ feed_version: "v", feed_start_date: "20260901", feed_end_date: "20261231" }],
    "routes.txt":         [{ route_id: route, route_short_name: route, route_long_name: "Route", route_color: "", route_text_color: "" }],
    "calendar.txt":       [{ service_id: "S", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0", start_date: "20260901", end_date: "20261231" }],
    "calendar_dates.txt": [],
    "stops.txt":          stops.map((id, i) => ({ stop_id: id, stop_name: `Stop ${id}`, stop_lat: `${43.13 + i / 100}`, stop_lon: "-70.93" })),
    "trips.txt":          [{ trip_id: "T", route_id: route, service_id: "S", trip_headsign: "Town", shape_id: "" }],
    "stop_times.txt":     stopTimes.map((stopTime, i) => ({ trip_id: "T", stop_id: stops[i], stop_sequence: `${i}`, ...stopTime })),
    "shapes.txt":         []
  }
  return convert(name => rows[name], corrections)
}

test("each stop time's own pickup and drop-off rules, and arrival before departure, come through to the trip", () => {
  const [trip] = tables([
    { arrival_time: "08:00:00", departure_time: "08:00:00", drop_off_type: "1" },
    { arrival_time: "08:10:00", departure_time: "08:12:00", pickup_type: "1", drop_off_type: "1" },
    { arrival_time: "08:20:00", departure_time: "08:20:00", pickup_type: "1" }
  ]).trips
  expect(trip.times).toEqual([8 * 3600, 8 * 3600 + 720, 8 * 3600 + 1200])
  expect(trip.arrivals).toEqual([8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200])
  // Nobody gets on at the last stop or off at the first anyway
  expect(trip.noPickup).toEqual([1])
  expect(trip.noDropOff).toEqual([1])
  const [plain] = tables([
    { arrival_time: "08:00:00", departure_time: "08:00:00" },
    { arrival_time: "08:10:00", departure_time: "08:10:00" },
    { arrival_time: "08:20:00", departure_time: "08:20:00" }
  ]).trips
  expect(plain).not.toHaveProperty("arrivals")
  expect(plain).not.toHaveProperty("noPickup")
  expect(plain).not.toHaveProperty("noDropOff")
})

const clock = (seconds: number) =>
  [seconds / 3600, seconds / 60 % 60, seconds % 60].map(part => String(Math.floor(part)).padStart(2, "0")).join(":")

test("a correction stops pickups or drop-offs at its stop on its route from its time on, and nowhere else", () =>
  fc.assert(fc.property(
    fc.array(fc.nat({ max: 1200 }), { minLength: 3, maxLength: 3 }),
    fc.integer({ min: 22 * 3600, max: 25 * 3600 }),
    fc.integer({ min: 22 * 3600, max: 25 * 3600 }),
    fc.constantFrom("R", "Q"),
    fc.constantFrom<"pickup" | "dropOff">("pickup", "dropOff"),
    (gaps, start, from, route, rule) => {
      let time = start
      const times = gaps.map((gap, i) => i === 0 ? time : time += gap)
      const [trip] = tables(
        times.map(at => ({ arrival_time: clock(at), departure_time: clock(at) })),
        { route, corrections: [{ route: "R", stop: "b", from, [rule]: false }] }
      ).trips
      const isCut = route === "R" && times[1] >= from
      expect(trip.noPickup ?? []).toEqual(rule === "pickup" && isCut ? [1] : [])
      expect(trip.noDropOff ?? []).toEqual(rule === "dropOff" && isCut ? [1] : [])
    }
  ))
)

test("the Evening Connector's loops due at West Edge after midnight pick nobody up there, nor let anyone off beyond 10 West Edge Drive", () => {
  // 218 Main Street, 10 West Edge Drive, West Edge Lot, and the Lodges, the end of each loop
  const stops = ["162", "173", "169", "181"]
  const loop = (times: string[]) =>
    tables(times.map(at => ({ arrival_time: at, departure_time: at })), { route: "Evening", stops, corrections: CORRECTIONS }).trips[0]
  const late = loop(["24:05:00", "24:08:00", "24:09:00", "24:10:00"])
  expect(late.noPickup).toEqual([1, 2])
  expect(late.noDropOff).toEqual([2, 3])
  const earlier = loop(["23:55:00", "23:57:00", "23:58:00", "23:59:00"])
  expect(earlier).not.toHaveProperty("noPickup")
  expect(earlier).not.toHaveProperty("noDropOff")
})
