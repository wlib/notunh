import { test, expect } from "vitest"
import fc from "fast-check"
import { convert, type NutrisliceFood, type NutrisliceWeek } from "../../scripts/dining/convert.mts"
import { publish } from "../../scripts/dining/publish.mts"
import { DIETS, passes, type Food, type Meal, type SearchFood } from "../../src/dining/menus.mts"
import { createSearch } from "../../src/dining/search.mts"

const TAGS = [...DIETS, "Milk", "Egg", "Wheat", "Gluten", "Soy", "Fish", "Pork", "Guiding Stars 2 stars"]

const word = fc.stringMatching(/^[A-Za-zé]{2,10}$/)

// The same id is always the same food, as in Nutrislice
const nutrisliceFood = fc.integer({ min: 1, max: 40 }).map((id): NutrisliceFood => ({
  id,
  name: `Food ${id}`,
  ingredients: id % 3 ? `Thing ${id}, Other ${id % 5}` : null,
  icons: { food_icons: TAGS.filter((_, i) => (id >> i) & 1).map(name => ({ name })) }
}))

// A day's items: station headers and foods, in order, as Nutrislice lists them
const day = fc.array(
  fc.oneof(
    word.map(text => ({ is_station_header: true, text, food: null })),
    nutrisliceFood.map(food => ({ is_station_header: false, text: "", food }))
  ),
  { maxLength: 20 }
)

const weekOf = (dates: string[]) =>
  fc.tuple(...dates.map(() => day)).map((days): NutrisliceWeek => ({
    days: days.map((menu_items, i) => ({ date: dates[i], menu_items }))
  }))

const DATES = ["2026-10-01", "2026-10-02", "2026-10-03"]

test("each meal keeps every food it lists, in order, under the station it was listed under", () =>
  fc.assert(fc.property(weekOf(DATES), fc.constantFrom(...DATES), (week, from) => {
    const data = convert([{ id: "hall", name: "Hall" }], [{ hall: "hall", meal: "lunch", week }], 0, from)

    for (const listed of week.days.filter(listed => listed.date >= from)) {
      const menu = data.menus.find(menu => menu.day === listed.date)
      const foods = listed.menu_items.flatMap(item => item.food ? [item.food.name.trim()] : [])
      expect(menu?.stations.flatMap(station => station.foods.map(food => data.foods[food].name)) ?? []).toEqual(foods)
      for (const station of menu?.stations ?? [])
        expect(station.foods.length).toBeGreaterThan(0)
    }
    expect(data.menus.every(menu => menu.day >= from)).toBe(true)
  }))
)

test("each Nutrislice food is kept once, however often it's served", () =>
  fc.assert(fc.property(weekOf(DATES), week => {
    const data = convert([{ id: "hall", name: "Hall" }], [{ hall: "hall", meal: "lunch", week }, { hall: "hall", meal: "dinner", week }], 0, DATES[0])
    const ids = new Set(week.days.flatMap(listed => listed.menu_items.flatMap(item => item.food ? [item.food.id] : [])))
    expect(data.foods.length).toBe(ids.size)
  }))
)

const twoMeals = (week: NutrisliceWeek) =>
  convert(
    [{ id: "hall", name: "Hall" }, { id: "other", name: "Other" }],
    [{ hall: "hall", meal: "lunch", week }, { hall: "other", meal: "dinner", week }],
    0,
    DATES[0]
  )

test("the published files put every meal back together, with each food in a file of its own", () =>
  fc.assert(fc.property(weekOf(DATES), week => {
    const data = twoMeals(week)
    const { index, files } = publish(data)
    const read = <T,>(file: string): T => JSON.parse(files.get(file)!)

    expect(new Set(index.files)).toEqual(new Set(files.keys()))
    for (const menu of data.menus) {
      const day = index.days[menu.hall][menu.day]
      const meal = read<Meal[]>(day.file).find(({ meal }) => meal === menu.meal)!
      expect(day.meals).toContain(menu.meal)
      expect(meal.stations.map(station => station.name)).toEqual(menu.stations.map(station => station.name))
      meal.stations.forEach((station, i) =>
        expect(station.foods.map(food => read<Food>(food.file))).toEqual(menu.stations[i].foods.map(food => data.foods[food]))
      )
    }
  }))
)

test("a food is the same file however many days serve it, and search lists it once with each meal serving it", () =>
  fc.assert(fc.property(weekOf(DATES), week => {
    const data = twoMeals(week)
    const { index, files } = publish(data)
    const search = JSON.parse(files.get(index.search)!) as SearchFood[]

    expect(files.size).toBe(new Set([...files.values()]).size)
    expect(search.map(food => food.name)).toEqual([...new Set(search.map(food => food.name))])
    for (const food of search)
      for (const { hall, day, meal } of food.servings)
        expect(data.menus.some(menu =>
          menu.hall === hall && menu.day === day && menu.meal === meal &&
          menu.stations.some(station => station.foods.some(i => data.foods[i].name === food.name))
        )).toBe(true)
  }))
)

const food = fc.record({
  name: fc.array(word, { minLength: 1, maxLength: 4 }).map(words => words.join(" ")),
  diets: fc.subarray(DIETS),
  contains: fc.subarray(["Milk", "Egg", "Wheat", "Soy", "Pork"]),
  nutrition: fc.constant({})
}) satisfies fc.Arbitrary<Food>

test("filters keep exactly the foods suiting every chosen diet and containing nothing avoided", () =>
  fc.assert(fc.property(food, fc.subarray(DIETS), fc.subarray(["Milk", "Egg", "Wheat", "Soy", "Pork"]), (item, diets, avoid) => {
    const kept = passes(item, { diets: new Set(diets), avoid: new Set(avoid) })
    expect(kept).toBe(
      diets.every(diet => item.diets.includes(diet)) &&
      avoid.every(thing => !item.contains.includes(thing))
    )
  }))
)

const menu: Food[] = [
  { name: "Chickpea Tinga", ingredients: [["Garbanzo Beans", ["Chick Peas", "Water", "Salt"]], "Cilantro"], diets: ["Vegan"], contains: [], nutrition: {} },
  { name: "Jalapeño Poppers", ingredients: ["Jalapeños", ["Cheddar Cheese", ["milk", "salt"]]], diets: [], contains: ["Milk"], nutrition: {} },
  { name: "Roasted Beet Patty", ingredients: ["Beets", "Brown Rice", "Chickpeas", "Lentils"], diets: ["Vegan"], contains: [], nutrition: {} },
  { name: "Mac and Cheese", ingredients: ["Pasta", ["Cheese Sauce", ["Cheddar Cheese", "Milk"]]], diets: ["Vegetarian"], contains: ["Milk"], nutrition: {} },
  { name: "Plain Pasta", ingredients: ["Pasta", "Water"], diets: ["Vegan"], contains: ["Wheat"], nutrition: {} }
]
const searchMenu = createSearch(menu)
const names = (query: string) => searchMenu(query).map(({ food }) => menu[food].name)

test("foods named for a search come before those with it as an ingredient, which say which one", () => {
  expect(names("chickpea")).toEqual(["Chickpea Tinga", "Roasted Beet Patty"])
  expect(searchMenu("chickpea")[1].ingredients.has("Chickpeas")).toBe(true)
})

test("search forgives a typo, accents, case, and word order, and leaves out words marked with a dash", () => {
  expect(names("chikpea")).toContain("Chickpea Tinga")
  expect(names("JALAPENO")).toEqual(["Jalapeño Poppers"])
  expect(names("cheese mac")).toContain("Mac and Cheese")
  expect(names("pasta -cheese")).toEqual(["Plain Pasta"])
})

test("every food is found by its own name", () => {
  for (const [i, { name }] of menu.entries())
    expect(searchMenu(name).map(({ food }) => food)).toContain(i)
})
