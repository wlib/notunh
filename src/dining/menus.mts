// Dining hall menus' shapes and filters. scripts/dining/convert.mts converts the menus from Nutrislice, then
// scripts/dining/publish.mts splits them into the files the dining page loads

import * as v from "valibot"
import type { Ingredient } from "./ingredients.mts"
import type { Day } from "../shared/time.mts"
import { objectOf } from "../shared/json.mts"

const Hall = v.object({
  id:   v.string(),
  name: v.string()
})
export type Hall = v.InferOutput<typeof Hall>

/** When a hall opens and closes, as minutes after midnight, with closing after midnight past 1440 */
export type Span = [open: number, close: number]

/** A hall's usual hours, which breaks and holidays change */
export type Hours = {
  /** Monday first: each day's open spans, with none when it's closed */
  week: Span[][],
  /** By day: one-off hours this week, like an early close, and why */
  special?: Record<Day, { spans: Span[], note: string }>
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
  day: Day,
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

/**
 * Whether a menu's item is a counter rather than a dish, as UNH Dining lists them beside the dishes: a bar, a station,
 * a make-your-own, a sauce or a topping to go on something, an assortment
 */
const isCounter = (name: string) =>
  /\b(bar|station|specialty|smorgasbord|make your own)\b|\b(sauce|topping|syrup|dressing)s?$|^assorted\b/i.test(name)

/** Whether a dish is a side, which a meal is named by only once its mains are */
const isSide = (name: string) =>
  /^(steamed|whole kernel)\b|\b(rice|fries|potatoes|pilaf|medley|corn|broccoli|quinoa|noodles|rolls|toast)$/i.test(name)

/** The stations that serve the same every day, as UNH Dining names them */
const EVERY_DAY = /^(salad|deli|soup|pizza|dessert|yogurt|bakery|cereal|fruit)|grill|breakfast|bar$/i

/**
 * Where a station comes in naming a meal: a special, then the main line, then the rest, and last those that serve the
 * same every day, a salad bar or any other, a deli, the grill, pizza, soup, breakfast and dessert
 */
const placeOf = (station: string) =>
  /^special/i.test(station)  ? 0 :
  /main line/i.test(station) ? 1 :
  EVERY_DAY.test(station)    ? 3 :
                               2

/** A dish's name as a person says it, without its portion, hall or tags: "Beyond Burger Patty 4oz", "Beyond Burger Patty" */
export const dishName = (name: string) =>
  name.replace(/^AF\s+/, "").replace(/\s*\([^)]*\)/g, "").replace(/\s*\b\d+(\.\d+)?\s*oz\b\.?/gi, "").replace(/\s+-\s+\w+$/, "").replace(/[\s-]+$/, "").replace(/\s+/g, " ").trim()

/** A station's name as a person says it, without which side of the line it is: "Main Line Left" is "Main Line" */
export const stationName = (name: string) =>
  name.replace(/\s+(left|right|\d+)$/i, "")

/**
 * A meal's dishes to name first, each with its station, by name as a person says them: its mains before its sides,
 * and of each, those of the stations that change before those that serve the same every day, a special's and the
 * main line's first, then a station at a time, so none is named twice until each has been once. Never a counter. By
 * the names as UNH Dining writes them, so a station renamed only loses its place in the order
 */
export const highlights = (meal: Meal, most: number) => {
  const stations = meal.stations
    .map(({ name, foods }) => ({ station: stationName(name), place: placeOf(name), dishes: foods.map(({ name }) => dishName(name)).filter(name => name && !isCounter(name)) }))
    .toSorted((a, b) => a.place - b.place)
  const named: { food: string, station: string }[] = []
  for (const isMain of [true, false])
    for (const isEveryDay of [false, true]) {
      const kept = stations.filter(({ place }) => place === 3 === isEveryDay).map(({ station, dishes }) => ({ station, dishes: dishes.filter(name => isSide(name) !== isMain) }))
      for (let round = 0; named.length < most && kept.some(({ dishes }) => dishes.length > round); round++)
        for (const { station, dishes } of kept)
          if (dishes[round] && named.length < most && !named.some(({ food }) => food === dishes[round]))
            named.push({ food: dishes[round], station })
    }
  return named
}

export type Serving = Pick<Menu, "hall" | "day" | "meal">

/** An upcoming food with what searching needs: its ingredients, and where and when it's served */
export type SearchFood = FoodSummary & Pick<Food, "ingredients"> & {
  servings: Serving[]
}

/** What the dining page loads first, naming the files with everything else, its hours and days taken on trust */
export const MenusIndex = v.object({
  /** Epoch milliseconds the menus were fetched */
  fetched:  v.number(),
  halls:    v.array(Hall),
  /** By hall, where its hours are known */
  hours:    objectOf<Record<string, Hours>>(),
  /** Diets some food suits */
  diets:    v.array(v.string()),
  /** Everything some food contains, most common first */
  contains: v.array(v.string()),
  /** By hall, then day: the file with that day's Meals, and which meals they are */
  days:     objectOf<Record<string, Record<Day, { file: string, meals: string[] }>>>(),
  /** The file with every SearchFood */
  search:   v.string(),
  /** Every file in use, by path, which the service worker keeps with the index (Retain in src/shell/manifest.mts) */
  files:    v.array(v.string())
})
export type MenusIndex = v.InferOutput<typeof MenusIndex>

export const DATA_PATH = "/data/dining/"

export const fileUrl = (file: string) =>
  `${DATA_PATH}${file}.json`

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
