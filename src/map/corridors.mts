// Routes sharing a street drawn side by side like a transit diagram, rather than on top of each other,
// one lane per route whichever way it goes

import { alongSegment, angleBetween, bearing, segmentMeters, type Coordinates } from "./geometry.mts"

const STEP = 12     // m between points once resampled, the resolution lanes change at
const NEAR = 18     // m, lines this close along the same street share it
const PARALLEL = 35 // degrees, lines crossing at more than this only meet at an intersection
const MIN_RUN = 8   // segments, shorter lane changes are noise where routes merge and split
const TAPER = 30    // m a lane change slides across over, eased in and out
const FINE = 3      // m between points within a slide, so it curves rather than bends
// Lanes are ordered across a street as seen facing along it in a direction folded into [AXIS, AXIS + 180),
// so every route on the street agrees on the order. A street running along the fold could fall either side of it,
// so this is the fold that, tried against Durham's routes, crosses and overlaps them least
const AXIS = 152 // degrees

export type Strand = {
  route: string,
  coordinates: Coordinates[]
}

/** A strand's lane, as how many lanes to the right of its own direction it runs at each of its points */
export type LaneSlots = {
  route: string,
  points: Coordinates[],
  slots: number[]
}

/** A piece of a strand's lane at one slot, which a map pushes over on screen by that many line widths */
export type Lane = {
  route: string,
  /** Fractional within a slide from one slot to the next */
  slot: number,
  /** One short step of a slide, rather than a run between them */
  isSliding: boolean,
  coordinates: Coordinates[]
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
  const t = alongSegment(px - ax, py - ay, dx, dy)
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
  /** The routes alongside each segment */
  segments: ReadonlySet<string>[]
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

      return alongside
    })
  }))
}

/** A run of segments' slots, with each change between runs eased over TAPER, at points FINE apart within it */
const taper = (points: Coordinates[], slots: number[]) => {
  const along = [0]
  for (let i = 1; i < points.length; i++)
    along.push(along[i - 1] + segmentMeters(points[i - 1], points[i]))
  // A change between two segments is centered on the point they share
  const changes = slots.flatMap((slot, i) => i && slot !== slots[i - 1] ? [{ at: along[i], by: slot - slots[i - 1] }] : [])
  const slotAt = (meters: number) =>
    changes.reduce((slot, { at, by }) => {
      const t = Math.min(1, Math.max(0, (meters - at) / TAPER + 0.5))
      return slot + by * t * t * (3 - 2 * t)
    }, slots[0] ?? 0)

  const tapered: Pick<LaneSlots, "points" | "slots"> = { points: [], slots: [] }
  points.forEach((point, i) => {
    const [from, to] = [along[i], along[i + 1]]
    const isSliding = to !== undefined && changes.some(({ at }) => from < at + TAPER / 2 && to > at - TAPER / 2)
    const steps = isSliding ? Math.ceil((to - from) / FINE) : 1
    for (let step = 0; step < steps; step++) {
      const t = step / steps
      const next = points[i + 1] ?? point
      tapered.points.push([point[0] + (next[0] - point[0]) * t, point[1] + (next[1] - point[1]) * t])
      tapered.slots.push(slotAt(from + ((to ?? from) - from) * t))
    }
  })
  return tapered
}

/**
 * The shown routes' strands, each at a slot across the street at every point: in the given order among the routes
 * alongside, flipped for strands facing against the axis, and easing from one slot to the next
 */
export const laneSlots = (corridors: Corridors, shown: ReadonlySet<string>, order: string[]): LaneSlots[] => {
  const rank = new Map(order.map((route, i) => [route, i]))
  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)

  return corridors
    .filter(({ strand }) => shown.has(strand.route))
    .map(({ strand: { route }, points, segments }) => {
      const present = segments.map(alongside => [...alongside].filter(other => shown.has(other)).sort(byRank))
      // Stretches with the same routes alongside, each facing along the axis or against it as a whole
      const slots: number[] = []
      for (let start = 0, end = 1; start < segments.length; start = end++) {
        while (end < segments.length && present[end].join() === present[start].join())
          end++
        const isWithAxis = ((bearing(points[start], points[end]) - AXIS) % 360 + 360) % 360 < 180
        // Left to right facing along the axis, so flipped for strands going the other way
        const position = present[start].indexOf(route) - (present[start].length - 1) / 2
        slots.push(...Array<number>(end - start).fill(isWithAxis ? position : -position))
      }
      return { route, ...taper(points, smooth(slots)) }
    })
}

/**
 * Each strand's lane in pieces at one slot each: runs between slides, and a step for each pair of points within
 * one, each a fraction of a lane over from the last, which round caps join without a seam
 */
export const lanePieces = (lanes: LaneSlots[]): Lane[] =>
  lanes.flatMap(({ route, points, slots }) => {
    const pieces: Lane[] = []
    for (let i = 1; i < points.length; i++) {
      const slot = (slots[i - 1] + slots[i]) / 2
      const last = pieces.at(-1)
      if (last?.slot === slot)
        last.coordinates.push(points[i])
      else
        pieces.push({ route, slot, isSliding: slots[i - 1] !== slots[i], coordinates: [points[i - 1], points[i]] })
    }
    return pieces
  })
