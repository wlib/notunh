// What every learned model shares: a fold over whole days, with everything learned worth half as much every
// HALF_LIFE days, so a new semester's pattern takes over within a month

import { type Day, daysBetween } from "./time.mts"

export const HALF_LIFE = 28 // days

export type Learned = {
  /** Bumped when the shape changes, so a stored model of an older shape is refit rather than misread */
  version: number,
  /** The last whole day folded in */
  through: Day | null
}

/** How much what was learned some days ago still counts */
export const decay = (days: number) =>
  0.5 ** (days / HALF_LIFE)

/** Numbers to what JSON keeps of them, so a model read back folds on exactly as one that never left memory */
export const rounded = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_, x) => typeof x === "number" ? Math.round(x * 1e4) / 1e4 : x))

/**
 * A day folded into a model: what came before, scaled by how much it still counts however many days have passed
 * since, with the day's observations added. A day at or before the last changes nothing, so refolding the same days
 * gives the same model
 */
export const foldDay = <M extends Learned>(model: M, day: Day, scale: (model: M, by: number) => M, add: (model: M) => M): M => {
  if (model.through !== null && day <= model.through)
    return model
  const before = model.through === null ? model : scale(model, decay(daysBetween(model.through, day)))
  return rounded({ ...add(before), through: day })
}
