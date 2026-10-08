// What's being looked at and searched for: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import indexUrl from "./menus.json?url"
import { fileUrl, type Filters, type Food, type Meal, type MenusIndex, type SearchFood, type Serving } from "./menus.mts"
import { createSearch } from "./search.mts"
import { status } from "./hours.mts"
import { getJson } from "../shared/json.mts"
import { localDay, localHour, localMinutes } from "../shared/time.mts"
import { now as clock, today } from "../shell/lifecycle.mts"
import { distinct, remembered, toggled } from "../shell/state.mts"

export const index = await getJson<MenusIndex>(indexUrl)

// Cached files the menus no longer use can go
navigator.serviceWorker?.controller?.postMessage({ keep: index.files.map(fileUrl) })

/** Each file's contents, loaded once */
const loaded = new Map<string, Promise<unknown>>()
const load = <T,>(file: string) => {
  if (!loaded.has(file))
    loaded.set(file, getJson<T>(fileUrl(file)).catch(error => {
      loaded.delete(file)
      throw error
    }))
  return loaded.get(file) as Promise<T>
}

/** A food's ingredients, nutrition, and the rest, by its file */
export const loadFood = (file: string) =>
  load<Food>(file)

/** Every day with a menu, from the day the page loaded on */
export const days = [...new Set(Object.values(index.days).flatMap(Object.keys))].filter(day => day >= today.peek()).sort()

//#region Remembered between visits

// Most people eat at one hall
export const hall = remembered("dining-hall", stored =>
  index.halls.find(({ id }) => id === stored)?.id ?? index.halls[0]?.id ?? ""
)

/** A remembered list, keeping only items that still exist */
const rememberedSet = (key: string, known: readonly string[]) =>
  remembered(key, stored => new Set(Array.isArray(stored) ? stored.filter(item => known.includes(item)) : []), set => [...set])

// Dietary needs don't change from visit to visit
const chosen = {
  diets: rememberedSet("dining-diets", index.diets),
  avoid: rememberedSet("dining-avoid", index.contains)
}
export const filters = r((): Filters => ({ diets: chosen.diets.value, avoid: chosen.avoid.value }))

export const toggleFilter = (kind: keyof Filters, item: string) => {
  chosen[kind].value = toggled(chosen[kind].value, item)
}

//#endregion

export const day = r(days[0] ?? today.peek())

const hour = localHour(clock.peek())

// The meal wanted, kept when it isn't served on a day, like breakfast on a day with brunch
export const preferredMeal = r(
  day.peek() !== today.peek()  ? "breakfast" :
  hour < 10                    ? "breakfast" :
  hour < 15                    ? "lunch" :
                                 "dinner"
)

/** The meals the hall serves that day */
export const meals = r(() => index.days[hall.value]?.[day.value]?.meals ?? [])

/** The hall's meals that day, undefined while they load, and empty when there's no menu */
export const dayMeals = r<Meal[]>()
export const hasFailed = r(false)
watch([hall, day], () => {
  const listed = index.days[hall.value]?.[day.value]
  dayMeals.value = listed ? undefined : []
  hasFailed.value = false
  if (!listed)
    return

  let isCurrent = true
  load<Meal[]>(listed.file)
    .then(meals => {
      if (isCurrent)
        dayMeals.value = meals
    })
    .catch(() => {
      if (isCurrent)
        hasFailed.value = true
    })
  return () => {
    isCurrent = false
  }
})

/** The meal to show, with brunch standing in for breakfast or lunch */
export const menu = r((): Meal | undefined => {
  const served = dayMeals.value ?? []
  return (
    served.find(({ meal }) => meal === preferredMeal.value) ??
    served.find(({ meal }) => meal === "brunch" && ["breakfast", "lunch"].includes(preferredMeal.value)) ??
    served[0]
  )
})

export const query = r("")
export const isSearching = r(() => query.value.trim().length >= 2)

/** Every upcoming food and a search over them, loaded once someone first searches */
export const searchable = r<{ foods: SearchFood[], search: ReturnType<typeof createSearch> }>()
watch([isSearching], () => {
  if (isSearching.value && !searchable.value)
    load<SearchFood[]>(index.search)
      .then(foods => {
        searchable.value ??= { foods, search: createSearch(foods) }
      })
      .catch(() => {
        hasFailed.value = true
      })
})

/** A food, by its file, to open and scroll to once its menu shows, from following a search result there */
export const focusedFood = r<string>()

/** Shows a meal's menu with a food on it opened */
export const goToFood = (file: string, { hall: servedAt, day: servedOn, meal }: Serving) => {
  hall.value = servedAt
  day.value = servedOn
  preferredMeal.value = meal
  focusedFood.value = file
  query.value = ""
}

/** Durham's wall clock, to the minute, as of the page's clock */
export const now = distinct(
  () => ({ day: localDay(clock.value), minute: localMinutes(clock.value) }),
  (a, b) => a.day === b.day && a.minute === b.minute
)

/** Whether each hall is open now, by hall, for halls with hours */
export const hallStatus = r(() =>
  Object.fromEntries(Object.entries(index.hours).map(([id, hours]) => [id, status(hours, now.value)]))
)

export const hallName = (id: string) =>
  index.halls.find(hall => hall.id === id)?.name ?? id
