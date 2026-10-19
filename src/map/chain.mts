// When a bus the map is following will leave each stop ahead of it: from the stop it was last seen at, each leg to
// the next stop as long as the model expects it to take at this time of day, scaled by how much slower or quicker
// this bus has lately been driving, and each stop as long as buses spend there. The map chains from what it sees
// of each bus (pace.mts), and the nightly build scores the same chain from what the samples show of them
// (scripts/map/replay.mts), so how far off the forecasts shown turn out is what the model learns

import { type Model, lingerEstimate, zoneEstimate } from "./model.mts"
import { type Pace, DEFAULT_ZONE, LEG_SIGMA, PACE_MEMORY, drifted, expectedMu } from "./pace.mts"
import type { Seen } from "./crossings.mts"

// A bus driving a leg has at least this share of its usual time to go, and is only so sure of what it has
const LEFT_SHARE = 0.15
const CURRENT_SPREAD = 0.35
// s more a bus already at a stop stays, before anything's been learned
const DEFAULT_LINGER = 30

/** A stop on a bus's way: its route there, whether a trip starts there, so it lays over, and the meters from the one before */
export type Waypoint = { stop: string, route: string, isFirst: boolean, meters: number }

/**
 * When a bus gets to and leaves each stop along a way from the one it was seen at, in epoch seconds, and the
 * variance of each departure in s², as of an epoch second
 */
export const chain = (model: Model, way: readonly Waypoint[], { arrive, depart }: Omit<Seen, "stop">, pace: Pace, now: number) => {
  const { mean: bias } = drifted(pace, now)
  const drive = (i: number) => {
    const mu = expectedMu(model, way[i].route, way[i - 1].stop, way[i].stop, way[i].meters, now)
    return { mean: Math.exp(mu + LEG_SIGMA ** 2 / 2), variance: Math.expm1(LEG_SIGMA ** 2) * Math.exp(2 * mu + LEG_SIGMA ** 2) }
  }

  // What's left of where it is: of its time at the stop, or of the leg it's driving, which its pace is already in
  const [first] = way
  const isThere = depart === undefined
  const leaving = !isThere && way.length > 1 ? drive(1).mean : 0
  const current = isThere
    ? lingerEstimate(model, first.route, first.stop, first.isFirst, now - arrive) ?? DEFAULT_LINGER
    : Math.max(leaving - (now - depart), LEFT_SHARE * leaving)
  let [time, variance, elapsed] = [now + current, (CURRENT_SPREAD * current) ** 2, current]
  const arrivals = [arrive]
  const times = [isThere ? time : depart]
  const variances = [isThere ? variance : 0]
  for (let i = 1; i < way.length; i++) {
    const leg = i === 1 && !isThere ? { mean: 0, variance: 0 } : drive(i)
    const stop = zoneEstimate(model, way[i].route, way[i].stop, way[i].isFirst) ?? { mean: DEFAULT_ZONE, variance: 0 }
    time += leg.mean * Math.exp(bias * Math.exp(-elapsed / PACE_MEMORY))
    arrivals.push(time)
    time += stop.mean
    elapsed += leg.mean + stop.mean
    variance += leg.variance + stop.variance
    times.push(time)
    variances.push(variance)
  }
  return { arrivals, times, variances }
}
