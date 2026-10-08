// Converts Nutrislice weekly menus into the compact JSON the dining page bundles: each food once,
// and each hall's meals as stations of indices into those foods

import { DIETS, MEALS, NUTRIENTS, type Food, type Menu, type MenusData, type Nutrition } from "../../src/dining/menus.mts"
import { parseIngredients } from "../../src/dining/ingredients.mts"

/** The parts of Nutrislice's responses used here */
export type NutrisliceFood = {
  id: number,
  name: string,
  description?: string | null,
  ingredients?: string | null,
  icons?: { food_icons?: { name: string }[] } | null,
  serving_size_info?: { serving_size_amount?: string | null, serving_size_unit?: string | null } | null,
  rounded_nutrition_info?: Record<string, number | null> | null
}

export type NutrisliceWeek = {
  days: {
    date: string,
    menu_items: {
      is_station_header: boolean,
      text: string,
      food: NutrisliceFood | null
    }[]
  }[]
}

const clean = (text: string | null | undefined) =>
  text?.replace(/\s+/g, " ").trim() || undefined

export const convertFood = (food: NutrisliceFood): Food => {
  const icons = food.icons?.food_icons?.map(icon => icon.name) ?? []
  const stars = icons.map(icon => icon.match(/^Guiding Stars (\d)/)?.[1]).find(Boolean)
  const { serving_size_amount: amount, serving_size_unit: unit } = food.serving_size_info ?? {}
  const nutrition: Nutrition = {}
  for (const { key } of NUTRIENTS) {
    const value = food.rounded_nutrition_info?.[key]
    if (typeof value === "number")
      nutrition[key] = value
  }

  return {
    name: clean(food.name)!,
    description: clean(food.description),
    ingredients: food.ingredients ? parseIngredients(food.ingredients) : undefined,
    diets: icons.filter(icon => DIETS.includes(icon)),
    contains: icons.filter(icon => !DIETS.includes(icon) && !icon.startsWith("Guiding Stars")),
    stars: stars ? +stars : undefined,
    serving: clean([amount, unit].filter(Boolean).join(" ")),
    nutrition
  }
}

export const convert = (
  halls: MenusData["halls"],
  weeks: { hall: string, meal: string, week: NutrisliceWeek }[],
  fetched: number,
  /** YYYY-MM-DD of the first day to keep, since weeks start before today */
  from: string
): MenusData => {
  const foods: Food[] = []
  const foodIndex = new Map<number, number>()
  const menus = new Map<string, Menu>()

  for (const { hall, meal, week } of weeks)
    for (const listed of week.days) {
      if (listed.date < from)
        continue
      const stations: Menu["stations"] = []
      for (const item of listed.menu_items) {
        if (item.is_station_header)
          stations.push({ name: clean(item.text) ?? "Other", foods: [] })
        else if (item.food?.name) {
          if (!foodIndex.has(item.food.id)) {
            foodIndex.set(item.food.id, foods.length)
            foods.push(convertFood(item.food))
          }
          if (!stations.length)
            stations.push({ name: "Other", foods: [] })
          stations.at(-1)!.foods.push(foodIndex.get(item.food.id)!)
        }
      }

      const filled = stations.filter(station => station.foods.length)
      // The same week can come back for two requested days, so key each meal to keep it once
      if (filled.length)
        menus.set(`${hall} ${listed.date} ${meal}`, { hall, day: listed.date, meal, stations: filled })
    }

  return {
    fetched,
    halls,
    foods,
    menus: [...menus.values()].sort((a, b) =>
      a.day.localeCompare(b.day) ||
      a.hall.localeCompare(b.hall) ||
      MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal)
    )
  }
}
