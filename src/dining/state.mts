// What's being looked at and searched for: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import { MenusIndex, fileUrl, type Filters, type Food, type Meal, type SearchFood, type Serving } from "./menus.mts"
import { createSearch } from "./search.mts"
import { status } from "./hours.mts"
import { arrayOf, objectOf } from "../shared/json.mts"
import { latest } from "../shell/build.mts"
import { jsonOf, loadImmutable } from "../shell/load.mts"
import { localDay, localHour, localMinutes } from "../shared/time.mts"
import { now as clock, today } from "../shell/lifecycle.mts"
import { distinct, remembered, toggled } from "../shell/state.mts"

/** The menus' index, swapped for a newer build's as it comes */
export const index = await latest("menus", MenusIndex)

// The index's files, each content-named, so immutable (load.mts)
const MEALS = jsonOf(arrayOf<Meal>())
const FOOD = jsonOf(objectOf<Food>())
const FOODS = jsonOf(arrayOf<SearchFood>())

/** A food's ingredients, nutrition, and the rest, by its file, saying each time it fails before it loads */
export const loadFood = (file: string, onError: (error: unknown) => void) =>
  loadImmutable(fileUrl(file), FOOD, { onError })

/** Every day with a menu from today on, recomputed when the index changes */
export const days = r(() =>
  [...new Set(Object.values(index.value.days).flatMap(Object.keys))].filter(day => day >= today.peek()).sort()
)

//#region Remembered between visits

// Most people eat at one hall
export const hall = remembered("dining-hall", stored =>
  index.peek().halls.find(({ id }) => id === stored)?.id ?? index.peek().halls[0]?.id ?? ""
)

/** A remembered list, keeping only items that still exist */
const rememberedSet = (key: string, known: readonly string[]) =>
  remembered(key, stored => new Set(Array.isArray(stored) ? stored.filter(item => known.includes(item)) : []), set => [...set])

// Dietary needs don't change from visit to visit
const chosen = {
  diets: rememberedSet("dining-diets", index.peek().diets),
  avoid: rememberedSet("dining-avoid", index.peek().contains)
}
export const filters = r((): Filters => ({ diets: chosen.diets.value, avoid: chosen.avoid.value }))

export const toggleFilter = (kind: keyof Filters, item: string) => {
  chosen[kind].value = toggled(chosen[kind].value, item)
}

//#endregion

export const day = r(days.peek()[0] ?? today.peek())
// A day a newer index no longer has gives way to its first
watch([days], () => {
  if (!days.value.includes(day.peek()))
    day.value = days.value[0] ?? today.peek()
})

const hour = localHour(clock.peek())

// The meal wanted, kept when it isn't served on a day, like breakfast on a day with brunch
export const preferredMeal = r(
  day.peek() !== today.peek()  ? "breakfast" :
  hour < 10                    ? "breakfast" :
  hour < 15                    ? "lunch" :
                                 "dinner"
)

/** The meals the hall serves that day */
export const meals = r(() => index.value.days[hall.value]?.[day.value]?.meals ?? [])

/** The file with the hall's meals that day, if it has a menu, changing only for another menu, not a newer index */
const dayFile = distinct(() => index.value.days[hall.value]?.[day.value]?.file)

/** The meals of the day file last loaded */
const loaded = r<{ file: string, meals: Meal[] }>()

/**
 * The hall's meals that day, undefined while they load, and empty when there's no menu. It's derived rather than set
 * by the watch below, so it's right from the start: bruh 2.0.0-beta.5 renders a reactive child under a watch with
 * skipFirst, whose first run, a microtask late, skips whatever changed that tick, so a menu known to be missing as the
 * page started would show as loading forever
 */
export const dayMeals = r(() => {
  const file = dayFile.value
  return !file ? [] : loaded.value?.file === file ? loaded.value.meals : undefined
})
export const hasFailed = r(false)
watch([dayFile], () => {
  const file = dayFile.value
  hasFailed.value = false
  if (!file)
    return

  const loading = new AbortController()
  loadImmutable(fileUrl(file), MEALS, { signal: loading.signal, onError: () => hasFailed.value = true })
    .then(meals => {
      hasFailed.value = false
      loaded.value = { file, meals }
    }, () => {})
  return () => loading.abort()
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

/** Every upcoming food and a search over them, loaded once someone first searches, and again for a newer index's */
export const searchable = r<{ file: string, foods: SearchFood[], search: ReturnType<typeof createSearch> }>()
const searchFile = distinct(() => isSearching.value ? index.value.search : searchable.peek()?.file)
watch([searchFile], () => {
  const file = searchFile.value
  if (file === undefined || searchable.peek()?.file === file)
    return
  const loading = new AbortController()
  loadImmutable(fileUrl(file), FOODS, { signal: loading.signal, onError: () => hasFailed.value = true })
    .then(foods => {
      hasFailed.value = false
      searchable.value = { file, foods, search: createSearch(foods) }
    }, () => {})
  return () => loading.abort()
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
  Object.fromEntries(Object.entries(index.value.hours).map(([id, hours]) => [id, status(hours, now.value)]))
)

export const hallName = (id: string) =>
  index.value.halls.find(hall => hall.id === id)?.name ?? id
