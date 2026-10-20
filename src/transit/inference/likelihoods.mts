// How a bus's GPS fixes read, fitted on the fixes of Oct 7 to 19: how far off its street a fix is, how its heading
// strays, how its speed reads when the bus stands still, and where a bus standing at a stop stands. That's how the GPS
// reads and where buses stand, which doesn't drift as the timetable or the traffic does. Matching (matching.mts) and
// what a bus did between fixes (passages.mts) weigh fixes by these

import { angleBetween } from "../../geo/projection.mts"
import { density } from "../../shared/normal.mts"

/** A fix as it's matched */
export type Observation = {
  /** Epoch seconds the fix was taken */
  at:        number,
  lat:       number,
  lon:       number,
  /** Degrees clockwise from north, which means nothing for a bus barely moving */
  heading?:  number | null,
  kph?:      number | null,
  /** m, the radius it's likely within, where the source says */
  accuracy?: number
}

// A fix is off the street it's on by about FIX_SIGMA, half-normally. A bus parked beside its route, as at a
// terminal's lot, is about LOT_SIGMA off, which LOT_SHARE of fixes are
const FIX_SIGMA = 2.5 // m
const LOT_SIGMA = 26  // m
const LOT_SHARE = 0.03
// How far a fix's heading is off its street's at each speed it reads, in km/h, interpolated between: half-normally
// by a spread in degrees, or any way at all some share of the time. A bus standing still has mostly lost its
// heading. One turning a corner, which the street's few bends cut short, is off the most
const HEADINGS: [kph: number, sigma: number, wild: number][] = [
  [0, 12.5, 0.62], [1, 9.9, 0.12], [2.5, 7.7, 0.03], [8, 14.9, 0.02], [17, 8.6, 0.04], [25, 5.4, 0.03], [35, 2.4, 0.02], [45, 1.4, 0.02]
]
// How likely a bus is to be standing still at each speed a fix reads, in whole km/h, as how far it moved between the
// fixes either side says, and faster, not at all. The GPS reads a bus standing still as 0, and one reading 1 to 5
// is creeping along. A fix without a speed is as likely as any (STILL_SHARE) to be standing still
const STILL = [0.969, 0.028, 0.009, 0.01, 0.014, 0.014, 0.002, 0]
const STILL_SHARE = 0.08
// Creeping up to a stop or away from it, as buses read 1 to 3 km/h doing, counts as being at it: that's what a stay
// at a stop is taken to be, rather than whether the bus moved. Counting creeping as moving, as STILL has it, put
// departures from every other fix 2.4 times as far from where all fixes put them (90th percentile 11 s against
// 4.6 s), as the drive between two fixes can't creep
export const CREEP = 3 // km/h
// Where a bus standing at a stop stands, in m past the stop: about STAND_OFFSET past where the timetable has it. A
// mixture of shares and spreads: mostly within a few meters, as each stop has buses stand in one place, and at some
// stops further off. HALTED is the rate per m of standing still anywhere else, against which standing at a stop is
// weighed
const STANDS: [share: number, sigma: number][] = [[0.598, 2.58], [0.13, 5.91]]
const STAND_OFFSET = 3.85 // m
const HALTED = 0.272 / 200 // per m
/** The normal density some way off its mean */
const normal = (off: number, sigma: number) =>
  density(off / sigma) / sigma

/** A row of a table by its first column, each other column interpolated between the rows either side, or held past its ends */
const interpolate = <Row extends number[]>(table: readonly Row[], x: number): Row => {
  const i = table.findIndex(row => row[0] > x)
  if (i <= 0)
    return table.at(i)!
  const [a, b] = [table[i - 1], table[i]]
  return a.map((value, j) => value + (b[j] - value) * (x - a[0]) / (b[0] - a[0])) as Row
}

export const speedOf = (fix: Observation) =>
  Math.max(0, (fix.kph ?? 0) / 3.6)

/** How likely a fix is of a bus standing still, by the speed it reads */
const stillness = ({ kph }: Observation) => {
  if (kph == null)
    return STILL_SHARE
  const i = Math.min(STILL.length - 1, Math.max(0, Math.floor(kph)))
  return STILL[i] + (STILL[Math.min(STILL.length - 1, i + 1)] - STILL[i]) * (Math.max(0, kph) - i)
}

/** A fix is of a bus standing still where that's likelier than its moving */
export const isStill = (fix: Observation) =>
  stillness(fix) > 0.5

/** How likely a bus standing still some meters past a stop is to be standing at it, rather than halted there */
export const standing = (offset: number) => {
  const at = STANDS.reduce((sum, [share, sigma]) => sum + share * normal(offset - STAND_OFFSET, sigma), 0)
  return at / (at + HALTED)
}

export const sigmaOf = (fix: Observation) =>
  Math.max(fix.accuracy ?? 0, FIX_SIGMA)

/** Log likelihood of a fix being at a candidate, from how far off it is, and its heading, as far as the fix has one */
export const emission = (fix: Observation, { meters, bearing }: { meters: number, bearing: number }) => {
  const off = Math.log((1 - LOT_SHARE) * 2 * normal(meters, sigmaOf(fix)) + LOT_SHARE * 2 * normal(meters, LOT_SIGMA))
  if (fix.heading == null || fix.kph == null)
    return off
  const [, sigma, wild] = interpolate(HEADINGS, fix.kph)
  return off + Math.log((1 - wild) * 2 * normal(angleBetween(fix.heading, bearing), sigma) + wild / 180)
}
