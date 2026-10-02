// What's being looked at and searched for: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import indexUrl from "./menus.json?url"
import { fileUrl, loadJson, type Filters, type Food, type Meal, type MenusIndex, type SearchFood, type Serving } from "./menus.mts"
import { createSearch } from "./search.mts"
import { status, type WallTime } from "./hours.mts"
import { localDay, localHour, localMinutes } from "../shell/time.mts"

export const index = await loadJson<MenusIndex>(indexUrl)

// Cached files the menus no longer use can go
navigator.serviceWorker?.controller?.postMessage({ keep: index.files.map(fileUrl) })

/** Each file's contents, loaded once */
const loaded = new Map<string, Promise<unknown>>()
const load = <T,>(file: string) => {
  if (!loaded.has(file))
    loaded.set(file, loadJson<T>(fileUrl(file)).catch(error => {
      loaded.delete(file)
      throw error
    }))
  return loaded.get(file) as Promise<T>
}

/** A food's ingredients, nutrition, and the rest, by its file */
export const loadFood = (file: string) =>
  load<Food>(file)

/** YYYY-MM-DD in Durham */
export const today = localDay(Date.now())
/** The next calendar day, which isn't always 24 hours later around daylight saving */
export const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** Every day with a menu, from today on */
export const dates = [...new Set(Object.values(index.days).flatMap(Object.keys))].filter(date => date >= today).sort()

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
export const hall = r(index.halls.find(({ id }) => id === storedHall)?.id ?? index.halls[0]?.id ?? "")
watch([hall], () => store("dining-hall", hall.value))

// Dietary needs don't change from visit to visit
export const filters = r<Filters>({
  diets: storedList("dining-diets", index.diets),
  avoid: storedList("dining-avoid", index.contains)
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

/** The meals the hall serves that day */
export const meals = r(() => index.days[hall.value]?.[date.value]?.meals ?? [])

/** The hall's meals that day, undefined while they load, and empty when there's no menu */
export const dayMeals = r<Meal[]>()
export const hasFailed = r(false)
watch([hall, date], () => {
  const day = index.days[hall.value]?.[date.value]
  dayMeals.value = day ? undefined : []
  hasFailed.value = false
  if (!day)
    return

  let isCurrent = true
  load<Meal[]>(day.file)
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
export const goToFood = (file: string, { hall: servedAt, date: servedOn, meal }: Serving) => {
  hall.value = servedAt
  date.value = servedOn
  preferredMeal.value = meal
  focusedFood.value = file
  query.value = ""
}

/** Durham's wall clock, to the minute */
export const now = r<WallTime>({ date: localDay(Date.now()), minute: localMinutes(Date.now()) })
const tick = () => {
  const date = localDay(Date.now())
  const minute = localMinutes(Date.now())
  if (date !== now.value.date || minute !== now.value.minute)
    now.value = { date, minute }
}
// On each minute, and on coming back to the page, since phones pause timers in the background
const everyMinute = () => {
  tick()
  setTimeout(everyMinute, 60_000 - Date.now() % 60_000)
}
everyMinute()
document.addEventListener("visibilitychange", tick)

/** Whether each hall is open now, by hall, for halls with hours */
export const hallStatus = r(() =>
  Object.fromEntries(Object.entries(index.hours).map(([id, hours]) => [id, status(hours, now.value)]))
)

export const hallName = (id: string) =>
  index.halls.find(hall => hall.id === id)?.name ?? id
