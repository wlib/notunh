// Splits converted menus into the files the dining page loads: an index, a file of each hall's meals each day,
// a file per food, and one of every food for searching. Every file but the index is named by a hash of what's in
// it, so a food served all week is one file, and anything unchanged from last night stays cached

import { createHash } from "node:crypto"
import { DIETS, type FoodSummary, type Meal, type MenusData, type MenusIndex, type SearchFood, type Serving, fileUrl } from "../../src/dining/menus.mts"
import { HOUR } from "../../src/shared/time.mts"

// How long an index's files stay published after it: two nights, for a tab still on last night's
const CARRY_MS = 48 * HOUR

/**
 * The files of the index the site serves now that tonight's must keep publishing, by URL: all it names that
 * tonight's doesn't, while it's less than two nights old, so a page still on it finds what it asks for
 */
export const carriedFiles = (serving: Pick<MenusIndex, "fetched" | "files"> | undefined, tonight: Pick<MenusIndex, "files">, now: number) =>
  serving && now - serving.fetched < CARRY_MS ? serving.files.filter(url => !tonight.files.includes(url)) : []

export const publish = (data: MenusData, hours: MenusIndex["hours"] = {}) => {
  const files = new Map<string, string>()
  const add = (value: unknown) => {
    const json = JSON.stringify(value)
    const name = createHash("sha256").update(json).digest("base64url").slice(0, 16)
    files.set(name, json)
    return name
  }

  const summaries = data.foods.map((food): FoodSummary => ({
    name: food.name,
    diets: food.diets,
    contains: food.contains,
    ...food.nutrition.calories === undefined ? {} : { calories: food.nutrition.calories },
    file: add(food)
  }))

  // Menus are in order by day, hall, and meal, so each day's meals and each food's servings come out in order
  const days: MenusIndex["days"] = {}
  const servings = data.foods.map(() => new Map<string, Serving>())
  for (const [key, menus] of Map.groupBy(data.menus, menu => `${menu.hall} ${menu.day}`)) {
    const { hall, day } = menus[0]
    const meals = menus.map(({ meal, stations }): Meal => ({
      meal,
      stations: stations.map(station => ({ name: station.name, foods: station.foods.map(food => summaries[food]) }))
    }))
    days[hall] ??= {}
    days[hall][day] = { file: add(meals), meals: meals.map(({ meal }) => meal) }
    for (const { meal, stations } of menus)
      for (const station of stations)
        for (const food of station.foods)
          servings[food].set(`${key} ${meal}`, { hall, day, meal })
  }

  const search = add(
    data.foods.flatMap((food, i): SearchFood[] =>
      servings[i].size
        ? [{ ...summaries[i], ...food.ingredients ? { ingredients: food.ingredients } : {}, servings: [...servings[i].values()] }]
        : []
    )
  )

  const counts = new Map<string, number>()
  for (const food of data.foods)
    for (const item of food.contains)
      counts.set(item, (counts.get(item) ?? 0) + 1)

  const index: MenusIndex = {
    fetched: data.fetched,
    halls: data.halls,
    hours,
    diets: DIETS.filter(diet => data.foods.some(food => food.diets.includes(diet))),
    contains: [...counts].sort((a, b) => b[1] - a[1]).map(([item]) => item),
    days,
    search,
    files: [...files.keys()].map(fileUrl)
  }
  return { index, files }
}
