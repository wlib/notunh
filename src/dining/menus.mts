// Dining hall menus, converted from Nutrislice by scripts/dining/convert.mts, and how to filter them

import type { Ingredient } from "./ingredients.mts"

export type Hall = {
  id:   string,
  name: string
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

/** The JSON written at build time */
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

export const loadMenus = async (url: string): Promise<MenusData> => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Failed to load menus: ${response.status}`)
  return response.json()
}

export type Filters = {
  /** Diets a food has to suit all of */
  diets: ReadonlySet<string>,
  /** Things a food can't contain any of */
  avoid: ReadonlySet<string>
}

export const passes = (food: Food, { diets, avoid }: Filters) =>
  [...diets].every(diet => food.diets.includes(diet)) &&
  !food.contains.some(item => avoid.has(item))
