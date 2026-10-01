// Searching foods by name and ingredient with uFuzzy, which forgives a typo per word ("chikpea"),
// matches words in any order, and leaves out words prefixed with "-" ("pasta -cheese")

import uFuzzy from "@leeoniya/ufuzzy"
import { flattenIngredients } from "./ingredients.mts"
import type { Food } from "./menus.mts"

const fuzzy = new uFuzzy({
  // A single error per word
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1
})

// Words permuted to match out of order, past which a search just has them in order
const OUT_OF_ORDER = 3

export type Match = {
  /** Index into the foods */
  food: number,
  /** Highlight ranges in the food's name, when it's the name that matched */
  name?: number[],
  /** Highlight ranges in each ingredient a search word matched */
  ingredients: Map<string, number[]>
}

/** Ranges of every match of a needle across some names, by name */
const rangesIn = (names: string[], needle: string) => {
  const ranges = new Map<string, number[]>()
  const [, info, order] = fuzzy.search(uFuzzy.latinize(names), needle, OUT_OF_ORDER)
  for (const i of order ?? [])
    ranges.set(names[info!.idx[i]], info!.ranges[i])
  return ranges
}

/** @returns foods matching a search: those named for it first, then those with it in their ingredients */
export const createSearch = (foods: Food[]) => {
  const names = uFuzzy.latinize(foods.map(food => food.name))
  const ingredients = foods.map(food => flattenIngredients(food.ingredients ?? []))
  const labels = uFuzzy.latinize(ingredients.map(list => list.join(", ")))

  return (query: string): Match[] => {
    const needle = uFuzzy.latinize(query.trim())
    if (!needle)
      return []

    const ranked = (haystack: string[]) => {
      const [idxs, info, order] = fuzzy.search(haystack, needle, OUT_OF_ORDER)
      return order
        ? order.map(i => ({ food: info.idx[i], ranges: info.ranges[i] }))
        : (idxs ?? []).map(food => ({ food, ranges: undefined }))
    }
    // Which ingredients each word is in, to show why a food matched
    const terms = fuzzy.split(needle).filter(term => !term.startsWith("-"))
    const ingredientRanges = (food: number) =>
      new Map(terms.flatMap(term => [...rangesIn(ingredients[food], term)]))

    const byName = ranked(names)
    const named = new Set(byName.map(({ food }) => food))
    return [
      ...byName.map(({ food, ranges }) => ({ food, name: ranges, ingredients: ingredientRanges(food) })),
      ...ranked(labels)
        .filter(({ food }) => !named.has(food))
        .map(({ food }) => ({ food, ingredients: ingredientRanges(food) }))
    ]
  }
}
