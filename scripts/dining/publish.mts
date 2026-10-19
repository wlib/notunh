// Splits converted menus into the files the dining page loads: an index, a file of each hall's meals each day,
// a file per food, and one of every food for searching. Every file but the index is named by a hash of what's in
// it, so a food served all week is one file, and anything unchanged from last night stays cached

import * as v from "valibot"
import { DIETS, type FoodSummary, type Meal, type MenusData, type MenusIndex, type SearchFood, type Serving, fileUrl } from "../../src/dining/menus.mts"
import { HOUR } from "../../src/shared/time.mts"
import { contentHash } from "../../src/shared/hash.mts"

// How long a file stays published past the last index that named it, for a tab still on that index
const CARRY_MS = 48 * HOUR

/**
 * The origin's record of the files published under /data/dining/ beyond the index's own, each by URL with when it
 * stops being published, kept beside them as published.json and read back by the next build
 */
export const Published = v.record(v.string(), v.number())
export type Published = v.InferOutput<typeof Published>

/**
 * What tonight's build publishes beyond its index's files: every file the index the site serves names, which stays
 * one more build whatever its age, as the previous generation does everywhere, and every file published before
 * whose time isn't up, each until two nights past the last index that named it
 */
export const carried = (serving: Pick<MenusIndex, "fetched" | "files"> | undefined, published: Published | undefined, tonight: Pick<MenusIndex, "files">, now: number): Published => {
  const until: Published = {}
  for (const [url, time] of Object.entries(published ?? {}))
    if (time >= now)
      until[url] = time
  for (const url of serving?.files ?? [])
    until[url] = Math.max(until[url] ?? 0, serving!.fetched + CARRY_MS, now)
  for (const url of tonight.files)
    delete until[url]
  return until
}

export const publish = async (data: MenusData, hours: MenusIndex["hours"] = {}) => {
  const files = new Map<string, string>()
  const add = async (value: unknown) => {
    const json = JSON.stringify(value)
    const name = (await contentHash(json, "base64url")).slice(0, 16)
    files.set(name, json)
    return name
  }

  const summaries = await Promise.all(data.foods.map(async (food): Promise<FoodSummary> => ({
    name: food.name,
    diets: food.diets,
    contains: food.contains,
    ...food.nutrition.calories === undefined ? {} : { calories: food.nutrition.calories },
    file: await add(food)
  })))

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
    days[hall][day] = { file: await add(meals), meals: meals.map(({ meal }) => meal) }
    for (const { meal, stations } of menus)
      for (const station of stations)
        for (const food of station.foods)
          servings[food].set(`${key} ${meal}`, { hall, day, meal })
  }

  const search = await add(
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
