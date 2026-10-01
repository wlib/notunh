// What's being looked at and searched for: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import menusUrl from "./menus.json?url"
import { DIETS, loadMenus, type Filters, type Menu } from "./menus.mts"
import { createSearch } from "./search.mts"
import { localDay, localHour } from "../shell/time.mts"

export const data = await loadMenus(menusUrl)
export const search = createSearch(data.foods)

/** YYYY-MM-DD in Durham */
export const today = localDay(Date.now())
/** The next calendar day, which isn't always 24 hours later around daylight saving */
export const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** Every day with a menu, from today on */
export const dates = [...new Set(data.menus.map(menu => menu.date))].filter(date => date >= today)

/** Everything foods are tagged as containing, most common first */
export const avoidable = (() => {
  const counts = new Map<string, number>()
  for (const food of data.foods)
    for (const item of food.contains)
      counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([item]) => item)
})()

//#region Remembered between visits

const stored = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null")
  }
  catch {
    return null
  }
}

/** A remembered list, keeping only items that still exist */
const storedList = (key: string, known: readonly string[]) => {
  const value = stored(key)
  return new Set(Array.isArray(value) ? value.filter(item => known.includes(item)) : [])
}

const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  }
  catch {}
}

// Most people eat at one hall
const storedHall = stored("dining-hall")
export const hall = r(data.halls.find(({ id }) => id === storedHall)?.id ?? data.halls[0]?.id ?? "")
watch([hall], () => store("dining-hall", hall.value))

// Dietary needs don't change from visit to visit
export const filters = r<Filters>({
  diets: storedList("dining-diets", DIETS),
  avoid: storedList("dining-avoid", avoidable)
})
watch([filters], () => {
  store("dining-diets", [...filters.value.diets])
  store("dining-avoid", [...filters.value.avoid])
})

export const toggleFilter = (kind: keyof Filters, item: string) => {
  const next = new Set(filters.value[kind])
  if (next.has(item))
    next.delete(item)
  else
    next.add(item)
  filters.value = { ...filters.value, [kind]: next }
}

//#endregion

export const date = r(dates[0] ?? today)

const hour = localHour(Date.now())

// The meal wanted, kept when it isn't served on a day, like breakfast on a day with brunch
export const preferredMeal = r(
  date.peek() !== today ? "breakfast" :
  hour < 10             ? "breakfast" :
  hour < 15             ? "lunch" :
                          "dinner"
)

const menusFor = (hallId: string, day: string) =>
  data.menus.filter(menu => menu.hall === hallId && menu.date === day)

export const meals = r(() => menusFor(hall.value, date.value).map(menu => menu.meal))

export const menu = r((): Menu | undefined => {
  const served = menusFor(hall.value, date.value)
  // Brunch stands in for breakfast or lunch
  return (
    served.find(menu => menu.meal === preferredMeal.value) ??
    served.find(menu => menu.meal === "brunch" && ["breakfast", "lunch"].includes(preferredMeal.value)) ??
    served[0]
  )
})

export const query = r("")
export const isSearching = r(() => query.value.trim().length >= 2)

/** A food to open and scroll to once its menu shows, from following a search result there */
export const focusedFood = r<number>()

/** Shows a meal's menu with a food on it opened */
export const goToFood = (food: number, menu: Menu) => {
  hall.value = menu.hall
  date.value = menu.date
  preferredMeal.value = menu.meal
  focusedFood.value = food
  query.value = ""
}

export const hallName = (id: string) =>
  data.halls.find(hall => hall.id === id)?.name ?? id

/** Each food's meals, soonest first */
export const servings = (() => {
  const byFood = new Map<number, Menu[]>()
  for (const menu of data.menus)
    for (const station of menu.stations)
      for (const food of station.foods) {
        const list = byFood.get(food) ?? []
        if (list.at(-1) !== menu)
          list.push(menu)
        byFood.set(food, list)
      }
  return byFood
})()
