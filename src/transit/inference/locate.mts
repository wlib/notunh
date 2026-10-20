// Where a bus is along its route, and when it got to and left each stop: each fix matched to a place along one of
// its route's lines (matching.mts), and what the bus did between them (passages.mts). A day's fixes are matched as a
// whole, as the nightly extraction reads them, and live ones a fix at a time, as the map follows a bus

import type { RouteLine } from "../shapes.mts"
import { type Observation, emission } from "./likelihoods.mts"
import { type Matched, MAX_SILENCE, SWITCH, candidates, match, transition } from "./matching.mts"
import { type Passage, GENERIC, tracker } from "./passages.mts"

/** Every passage a bus's fixes show, matched as a whole, as the nightly extraction reads them: in order, by track */
export const passagesOf = (lines: readonly RouteLine[], fixes: readonly Observation[], expect = GENERIC) => {
  const follow = tracker(lines, expect)
  return match(lines, fixes).map(track => [
    ...track.flatMap((point, k) => follow.push(point, k === 0)),
    ...follow.end()
  ])
}

/**
 * Follows one bus live, a fix at a time: observe gives back the passages each fix finished, and locate where the bus
 * is as of its last. Each fix is matched greedily, to its likeliest place given where the fix before was matched,
 * rather than kept as every way the bus could have come, so its passages are conditional on that one track
 */
export const locator = (lines: readonly RouteLine[], expect = GENERIC) => {
  const follow = tracker(lines, expect)
  let last: Matched | undefined

  const observe = (fix: Observation): Passage[] => {
    if (last && fix.at <= last.fix.at)
      return []
    const options = candidates(lines, fix)
    if (!options.length || (last && fix.at - last.fix.at > MAX_SILENCE)) {
      last = undefined
      return follow.end()
    }
    let best: { score: number, point: Matched, isNew: boolean } | undefined
    for (const option of options) {
      const step = last ? transition(lines, last, fix, option) : { log: 0, distance: option.distance, isNew: true }
      // Nowhere it could likelier have driven from, as matching a whole day has it, a track starts here
      const isDriven = step.log > -2 * SWITCH
      const score = (isDriven ? step.log : -2 * SWITCH) + emission(fix, option)
      if (!best || score > best.score)
        best = { score, point: { fix, line: option.line, distance: isDriven ? step.distance : option.distance }, isNew: step.isNew || !isDriven }
    }
    last = best!.point
    return follow.push(best!.point, best!.isNew)
  }

  return { observe, finish: () => follow.end(), locate: follow.location }
}
