// Downloads the dining halls' menus from Nutrislice (behind unh.nutrislice.com) for this week and the next two,
// as far ahead as UNH publishes, and converts them into the JSON the dining page bundles.
// Nutrislice doesn't send CORS headers, so this happens at build time, and CI rebuilds nightly.
// With --if-missing, menus already there are kept

import { access, writeFile } from "node:fs/promises"
import { localDay } from "../../src/shell/time.mts"
import { MEALS } from "../../src/dining/menus.mts"
import { convert, type NutrisliceWeek } from "./convert.mts"

const API = "https://unh.api.nutrislice.com/menu/api"
const OUTPUT = new URL("../../src/dining/menus.json", import.meta.url)
const WEEKS = 3

if (process.argv.includes("--if-missing") && await access(OUTPUT).then(() => true, () => false))
  process.exit(0)

const get = async <T,>(path: string): Promise<T> => {
  const response = await fetch(API + path)
  if (!response.ok)
    throw new Error(`Nutrislice ${response.status} ${path}`)
  return response.json()
}

type School = { slug: string, name: string, active_menu_types: { slug: string }[] }

// Dining halls are the schools serving meals, unlike stadium concessions
const halls = (await get<School[]>("/schools/"))
  .map(school => ({
    id: school.slug,
    name: school.name.replace(/^Dining - /, "").replace(/ Menus$/, ""),
    meals: school.active_menu_types.map(type => type.slug).filter(meal => MEALS.includes(meal))
  }))
  .filter(hall => hall.meals.length)

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "/")

const weeks = await Promise.all(
  halls.flatMap(hall =>
    hall.meals.flatMap(meal =>
      Array.from({ length: WEEKS }, async (_, week) => ({
        hall: hall.id,
        meal,
        week: await get<NutrisliceWeek>(`/weeks/school/${hall.id}/menu-type/${meal}/${day(week * 7)}/`)
      }))
    )
  )
)

const data = convert(halls.map(({ id, name }) => ({ id, name })), weeks, Date.now(), localDay(Date.now()))
// Nothing posted at all is a Nutrislice problem, not a quiet week, so failing keeps the last menus up
if (!data.menus.length)
  throw new Error("Nutrislice has no menus posted")

await writeFile(OUTPUT, JSON.stringify(data))
const dates = [...new Set(data.menus.map(menu => menu.date))]
console.log(`Wrote ${data.halls.length} halls, ${data.foods.length} foods, ${data.menus.length} meals (${dates[0]}–${dates.at(-1)})`)
