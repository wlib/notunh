// Routes sharing a street drawn side by side like a transit diagram, rather than on top of each other,
// one lane per route whichever way it goes

import { angleBetween, bearing, segmentMeters, type Coordinates } from "./geometry.mts"

const STEP = 12     // m between points once resampled, the resolution lanes change at
const NEAR = 18     // m, lines this close along the same street share it
const PARALLEL = 35 // degrees, lines crossing at more than this only meet at an intersection
const MIN_RUN = 8   // segments, shorter lane changes are noise where routes merge and split
// Lanes are ordered across a street as seen facing along it in a direction folded into [AXIS, AXIS + 180),
// so every route on the street agrees on the order. Odd, so few streets run right along the fold
const AXIS = 17 // degrees

export type Strand = {
  route: string,
  coordinates: Coordinates[]
}

export type Lane = {
  route: string,
  coordinates: Coordinates[],
  /** Line widths to the right of the lane's own direction */
  slot: number
}

/** Points no further than STEP apart along a line */
const resample = (coordinates: Coordinates[]) => {
  const points = [coordinates[0]]
  for (let i = 1; i < coordinates.length; i++) {
    const [a, b] = [coordinates[i - 1], coordinates[i]]
    const steps = Math.ceil(segmentMeters(a, b) / STEP)
    for (let step = 1; step <= steps; step++)
      points.push([a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps])
  }
  return points
}

type Segment = {
  strand: number,
  index:  number,
  /** Meters east and north of the origin */
  a: [number, number],
  b: [number, number],
  bearing: number
}

const distanceToSegment = ([px, py]: [number, number], { a: [ax, ay], b: [bx, by] }: Segment) => {
  const [dx, dy] = [bx - ax, by - ay]
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0
  return Math.hypot(ax + t * dx - px, ay + t * dy - py)
}

/** Merges runs shorter than MIN_RUN into their longer neighbor */
const smooth = (slots: number[]) => {
  const runs: { slot: number, length: number }[] = []
  for (const slot of slots)
    if (runs.at(-1)?.slot === slot)
      runs.at(-1)!.length++
    else
      runs.push({ slot, length: 1 })

  for (let i = 0; i < runs.length; i++) {
    const neighbors = [runs[i - 1], runs[i + 1]].filter(Boolean)
    if (runs[i].length >= MIN_RUN || !neighbors.length)
      continue
    runs[i].slot = neighbors.reduce((a, b) => a.length >= b.length ? a : b).slot
  }
  return runs.flatMap(({ slot, length }) => Array(length).fill(slot) as number[])
}

/** Each strand resampled, with the routes alongside each of its segments */
export type Corridors = {
  strand: Strand,
  points: Coordinates[],
  segments: {
    alongside: ReadonlySet<string>,
    /** Facing along the axis, rather than against it */
    isWithAxis: boolean
  }[]
}[]

/** Finds which routes share the street along each stretch of each strand, the slow part, done once */
export const measureCorridors = (strands: Strand[]): Corridors => {
  const resampled = strands.map(strand => resample(strand.coordinates))
  const origin = resampled.flat()[0] ?? [0, 0]
  const toMeters = ([lon, lat]: Coordinates): [number, number] => [
    (lon - origin[0]) * 111_320 * Math.cos(origin[1] * Math.PI / 180),
    (lat - origin[1]) * 110_540
  ]

  // Segments bucketed by grid cell, so only nearby ones get compared
  const CELL = NEAR + STEP
  const grid = new Map<string, Segment[]>()
  const cellOf = ([x, y]: [number, number]) => [Math.floor(x / CELL), Math.floor(y / CELL)]
  const segments = resampled.map((points, strand) =>
    points.slice(1).map((point, index): Segment => {
      const segment = { strand, index, a: toMeters(points[index]), b: toMeters(point), bearing: bearing(points[index], point) }
      const [cx, cy] = cellOf([(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2])
      const key = `${cx},${cy}`
      grid.set(key, [...grid.get(key) ?? [], segment])
      return segment
    })
  )

  return segments.map((strandSegments, strand) => ({
    strand: strands[strand],
    points: resampled[strand],
    segments: strandSegments.map(segment => {
      const middle: [number, number] = [(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2]
      const [cx, cy] = cellOf(middle)
      const alongside = new Set([strands[strand].route])

      for (let x = cx - 1; x <= cx + 1; x++)
        for (let y = cy - 1; y <= cy + 1; y++)
          for (const other of grid.get(`${x},${y}`) ?? []) {
            // A strand's own neighboring segments aren't another pass along the street
            if (other.strand === strand && Math.abs(other.index - segment.index) * STEP < 4 * NEAR)
              continue
            if (distanceToSegment(middle, other) > NEAR)
              continue
            const angle = angleBetween(segment.bearing, other.bearing)
            if (angle <= PARALLEL || angle >= 180 - PARALLEL)
              alongside.add(strands[other.strand].route)
          }

      return {
        alongside,
        isWithAxis: ((segment.bearing - AXIS) % 360 + 360) % 360 < 180
      }
    })
  }))
}

/** Splits the shown routes' strands into lanes, each a stretch with the same routes alongside, in the given order across it */
export const layLanes = (corridors: Corridors, shown: ReadonlySet<string>, order: string[]): Lane[] => {
  const rank = new Map(order.map((route, i) => [route, i]))
  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)

  return corridors
    .filter(({ strand }) => shown.has(strand.route))
    .flatMap(({ strand: { route }, points, segments }) => {
      const slots = segments.map(({ alongside, isWithAxis }) => {
        const present = [...alongside].filter(other => shown.has(other)).sort(byRank)
        // Left to right facing along the axis, so flipped for strands going the other way
        const position = present.indexOf(route) - (present.length - 1) / 2
        return isWithAxis ? position : -position
      })

      const lanes: Lane[] = []
      smooth(slots).forEach((slot, index) => {
        if (lanes.at(-1)?.slot === slot)
          lanes.at(-1)!.coordinates.push(points[index + 1])
        else
          lanes.push({ route, slot, coordinates: [points[index], points[index + 1]] })
      })
      return lanes
    })
}
