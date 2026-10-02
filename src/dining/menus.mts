// Dining hall menus: converted from Nutrislice by scripts/dining/convert.mts, then split by
// scripts/dining/publish.mts into the files the dining page loads, and how to filter them

import type { Ingredient } from "./ingredients.mts"

export type Hall = {
  id:   string,
  name: string
}

/** When a hall opens and closes, as minutes after midnight, with closing after midnight past 1440 */
export type Span = [open: number, close: number]

/** A hall's usual hours, which breaks and holidays change */
export type Hours = {
  /** Sunday first: each day's open spans, with none when it's closed */
  week: Span[][],
  /** By YYYY-MM-DD: one-off hours this week, like an early close, and why */
  special?: Record<string, { spans: Span[], note: string }>
}

export type Nutrition = Partial<Record<typeof NUTRIENTS[number]["key"], number>>

export type Food = {
  name: string,
  description?: string,
  ingredients?: Ingredient[],
  /** Diets it suits, like "Vegan" */
  diets: string[],
  /** Allergens and things some people avoid, like "Milk" or "Pork" */
  contains: string[],
  /** Guiding Stars' 1 to 3 star nutrition rating */
  stars?: number,
  serving?: string,
  nutrition: Nutrition
}

export type Station = {
  name: string,
  /** Indices into MenusData.foods */
  foods: number[]
}

export type Menu = {
  hall: string,
  /** YYYY-MM-DD, local */
  date: string,
  /** Like "breakfast" */
  meal: string,
  stations: Station[]
}

/** Every menu, as converted, before it's split up */
export type MenusData = {
  /** Epoch milliseconds the menus were fetched */
  fetched: number,
  halls: Hall[],
  foods: Food[],
  menus: Menu[]
}

export const DIETS = ["Vegan", "Vegetarian", "Halal"]

/** Meals in the order of a day */
export const MEALS = ["breakfast", "brunch", "lunch", "dinner"]

/** In label order, with Intl.NumberFormat units */
export const NUTRIENTS = [
  { key: "calories",        label: "Calories",      unit: undefined   },
  { key: "g_protein",       label: "Protein",       unit: "gram"      },
  { key: "g_carbs",         label: "Carbs",         unit: "gram"      },
  { key: "g_fiber",         label: "Fiber",         unit: "gram"      },
  { key: "g_sugar",         label: "Sugar",         unit: "gram"      },
  { key: "g_fat",           label: "Fat",           unit: "gram"      },
  { key: "g_saturated_fat", label: "Saturated fat", unit: "gram"      },
  { key: "g_trans_fat",     label: "Trans fat",     unit: "gram"      },
  { key: "mg_cholesterol",  label: "Cholesterol",   unit: "milligram" },
  { key: "mg_sodium",       label: "Sodium",        unit: "milligram" },
  { key: "mg_potassium",    label: "Potassium",     unit: "milligram" },
  { key: "mg_calcium",      label: "Calcium",       unit: "milligram" },
  { key: "mg_iron",         label: "Iron",          unit: "milligram" }
] as const

//#region Published files

/** A food as a menu lists it: enough to show and filter it, and the file with the rest */
export type FoodSummary = Pick<Food, "name" | "diets" | "contains"> & {
  calories?: number,
  /** The whole Food's file, named for what's in it, so every day serving it shares the one file */
  file: string
}

/** One meal's stations, at a hall on a day */
export type Meal = {
  meal: string,
  stations: { name: string, foods: FoodSummary[] }[]
}

export type Serving = Pick<Menu, "hall" | "date" | "meal">

/** An upcoming food with what searching needs: its ingredients, and where and when it's served */
export type SearchFood = FoodSummary & Pick<Food, "ingredients"> & {
  servings: Serving[]
}

/** What the dining page loads first, naming the files with everything else */
export type MenusIndex = {
  /** Epoch milliseconds the menus were fetched */
  fetched: number,
  halls: Hall[],
  /** By hall, where its hours are known */
  hours: Record<string, Hours>,
  /** Diets some food suits */
  diets: string[],
  /** Everything some food contains, most common first */
  contains: string[],
  /** By hall, then YYYY-MM-DD: the file with that day's Meals, and which meals they are */
  days: Record<string, Record<string, { file: string, meals: string[] }>>,
  /** The file with every SearchFood */
  search: string,
  /** Every file in use, so caches can drop the rest */
  files: string[]
}

export const DATA_PATH = "/data/dining/"

export const fileUrl = (file: string) =>
  `${DATA_PATH}${file}.json`

export const loadJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Failed to load ${url}: ${response.status}`)
  return response.json()
}

//#endregion

export type Filters = {
  /** Diets a food has to suit all of */
  diets: ReadonlySet<string>,
  /** Things a food can't contain any of */
  avoid: ReadonlySet<string>
}

export const passes = (food: Pick<Food, "diets" | "contains">, { diets, avoid }: Filters) =>
  [...diets].every(diet => food.diets.includes(diet)) &&
  !food.contains.some(item => avoid.has(item))
