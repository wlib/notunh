// Searching foods by name and ingredient, fuzzily, as the map searches places

import { flattenIngredients } from "./ingredients.mts"
import type { Food } from "./menus.mts"
import { fuzzySearch, latinize, splitTerms } from "../shared/fuzzy.mts"

export type Match = {
  /** Index into the foods */
  food: number,
  /** Highlight ranges in the food's name, when it's the name that matched */
  name?: number[],
  /** Highlight ranges in each ingredient a search word matched */
  ingredients: Map<string, number[]>
}

/** Ranges of every match of a needle across some names, by name */
const rangesIn = (names: string[], needle: string) =>
  new Map(fuzzySearch(latinize(names), needle).flatMap(({ index, ranges }) => ranges ? [[names[index], ranges]] : []))

/** @returns foods matching a search: those named for it first, then those with it in their ingredients */
export const createSearch = (foods: Pick<Food, "name" | "ingredients">[]) => {
  const names = latinize(foods.map(food => food.name))
  const ingredients = foods.map(food => flattenIngredients(food.ingredients ?? []))
  const labels = latinize(ingredients.map(list => list.join(", ")))

  return (query: string): Match[] => {
    const needle = latinize(query.trim())
    if (!needle)
      return []

    const ranked = (haystack: string[]) =>
      fuzzySearch(haystack, needle).map(({ index, ranges }) => ({ food: index, ranges }))
    // Which ingredients each word is in, to show why a food matched
    const terms = splitTerms(needle).filter(term => !term.startsWith("-"))
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
