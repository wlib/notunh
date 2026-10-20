// Which place along one of its route's lines each of a bus's fixes is at: an HMM over the places it could be, each
// weighed by how far off the fix is and its heading (likelihoods.mts), and by whether getting there from the place
// before is a plausible drive. A day's fixes are matched as a whole (Viterbi), and live ones by only what's come so far
// (locate.mts)

import { type Line, distanceAt, nearestOnSegment, segmentBearing } from "../../geo/lines.mts"
import type { RouteLine } from "../shapes.mts"
import { type Observation, emission, speedOf } from "./likelihoods.mts"

// The drive between two fixes is as long as their speeds say, give or take, Laplace distributed, by SLACK plus
// SLACK_SHARE of it. That's looser than the drives fit (about 1.3 m per second between fixes, or 20 m and 8 % of
// the drive). Both tighter fits lost 1 to 3 s at 10 and 20 minutes ahead: the drives were fitted only on what the
// looser bound matched, and its job is picking which pass of a line a fix is on
const SLACK = 20 // m
const SLACK_SHARE = 0.5
// What switching to another of the route's shapes costs, in log odds. Matched fixes switch about every 450th (6.1),
// but at that rate more passages were lost with every other fix dropped, so it's kept rarer
export const SWITCH = 8

// These are bounds rather than estimates.
// - SNAP: further from every line, a fix isn't on the route. Fixes of buses standing still are 30 to 45 m off it at
//   terminals' lots and 80 m and more where buses are out of service, with next to none between
// - PASSED: a line this much further from a fix than it was has passed it, six times as far off as fixes are
// - BACK: GPS never puts a bus this far back along its route, twelve times as far off as fixes are
// - MAX_SPEED: a bus gets no faster
// - MAX_SILENCE: longer between fixes starts a new track, as with nothing to go on, the bus may have gone off its
//   route and come back
const SNAP = 60       // m
const PASSED = 15     // m
const BACK = 30       // m
export const MAX_SPEED = 35  // m/s
export const MAX_SILENCE = 300 // s

/** A place along a line a fix could be, how far off it, and which way the line goes there */
type Candidate = { line: number, distance: number, meters: number, bearing: number }

/**
 * Where along each line a fix could be: the nearest point of each pass the line makes by it within SNAP, a pass
 * ending where the line goes off further than SNAP, or turns back and comes by again
 */
export const candidates = (lines: readonly Line[], fix: Observation) => {
  const found: Candidate[] = []
  lines.forEach((line, index) => {
    let best: { i: number, t: number, meters: number } | undefined
    const pass = () => {
      const { i, t, meters } = best!
      found.push({ line: index, distance: distanceAt(line, i, t), meters, bearing: segmentBearing(line, i) })
      best = undefined
    }
    let previous = Infinity
    for (let i = 0; i + 1 < line.coordinates.length; i++) {
      const { t, meters } = nearestOnSegment(line, i, fix)
      if (best && (meters > SNAP || meters > best.meters + PASSED))
        pass()
      // Nearing the fix, after going off from it
      if (meters <= SNAP && (best ? meters < best.meters : meters <= previous))
        best = { i, t, meters }
      previous = meters
    }
    if (best)
      pass()
  })
  return found
}

/** A fix matched to a line, laps and all */
export type Matched = { fix: Observation, line: number, distance: number }

/**
 * Log odds of driving from a matched fix to a candidate for the next, against driving as far as their speeds say,
 * and how far along that is, laps and all: never far back, and never faster than a bus goes. Switching lines is a
 * new track
 */
export const transition = (lines: readonly RouteLine[], from: Matched, fix: Observation, to: Candidate) => {
  if (to.line !== from.line)
    return { log: -SWITCH, distance: to.distance, isNew: true }
  const line = lines[to.line]
  let moved = to.distance - (line.isLoop ? from.distance - Math.floor(from.distance / line.length) * line.length : from.distance)
  if (line.isLoop) {
    moved = ((moved % line.length) + line.length) % line.length
    if (moved > line.length - BACK)
      moved -= line.length
  }
  const seconds = fix.at - from.fix.at
  const expected = (speedOf(from.fix) + speedOf(fix)) / 2 * seconds
  const log = moved < -BACK || moved > MAX_SPEED * seconds + SLACK
    ? -Infinity
    : -Math.abs(moved - expected) / (SLACK + SLACK_SHARE * expected)
  return { log, distance: from.distance + moved, isNew: false }
}

/**
 * The likeliest places along some lines for a bus's fixes in order, as tracks, each on one line, between which it
 * was lost, off the route, silent too long, or switched to another line (Viterbi)
 */
export const match = (lines: readonly RouteLine[], fixes: readonly Observation[]) => {
  const tracks: Matched[][] = []
  // Each run of fixes on the route, without a silence, matched as a whole
  let run: { fix: Observation, options: Candidate[] }[] = []
  const flush = () => {
    if (!run.length)
      return
    // For each fix, the best way to each of its candidates, laps and all, and where from
    const steps: { score: number, distance: number, from: number, isNew: boolean }[][] = [
      run[0].options.map(option => ({ score: emission(run[0].fix, option), distance: option.distance, from: -1, isNew: true }))
    ]
    for (let k = 1; k < run.length; k++) {
      const { fix, options } = run[k]
      const before = steps[k - 1]
      const restart = Math.max(...before.map(step => step.score)) - 2 * SWITCH
      steps.push(options.map(option => {
        // Nowhere it could have driven from, a track starts here
        let best = { score: restart, distance: option.distance, from: before.reduce((top, step, j) => step.score > before[top].score ? j : top, 0), isNew: true }
        before.forEach((previous, j) => {
          const step = transition(lines, { fix: run[k - 1].fix, line: run[k - 1].options[j].line, distance: previous.distance }, fix, option)
          if (previous.score + step.log > best.score)
            best = { score: previous.score + step.log, distance: step.distance, from: j, isNew: step.isNew }
        })
        return { ...best, score: best.score + emission(fix, option) }
      }))
    }
    // Back from the best last
    const path: (Matched & { isNew: boolean })[] = []
    let j = steps.at(-1)!.reduce((top, step, i, all) => step.score > all[top].score ? i : top, 0)
    for (let k = run.length - 1; k >= 0; k--) {
      const step = steps[k][j]
      path.push({ fix: run[k].fix, line: run[k].options[j].line, distance: step.distance, isNew: step.isNew })
      j = step.from
    }
    for (const { isNew, ...point } of path.reverse()) {
      if (isNew)
        tracks.push([])
      tracks.at(-1)!.push(point)
    }
    run = []
  }
  for (const fix of fixes) {
    if (run.length && fix.at <= run.at(-1)!.fix.at)
      continue
    const options = candidates(lines, fix)
    if (!options.length || (run.length && fix.at - run.at(-1)!.fix.at > MAX_SILENCE))
      flush()
    if (options.length)
      run.push({ fix, options })
  }
  flush()
  return tracks
}
