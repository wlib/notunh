// Downloads the dining halls' menus from Nutrislice (behind unh.nutrislice.com) for this week and the next two,
// as far ahead as UNH publishes, and splits them into the files the dining page loads: the index it bundles,
// and the rest under public/data/dining/. Nutrislice doesn't send CORS headers, so this happens at build time,
// and the site rebuilds nightly. With --if-missing, menus already there are kept

import { mkdir, rm, writeFile } from "node:fs/promises"
import * as v from "valibot"
import { addDays, localDay } from "../../src/shared/time.mts"
import { getJson, objectOf } from "../../src/shared/json.mts"
import { DATA_PATH, MEALS, MenusIndex } from "../../src/dining/menus.mts"
import { NutrisliceWeek, convert } from "./convert.mts"
import { hallHours, nutrisliceHours, parseUnhHours, UNH_PAGES, type NutrisliceSchool } from "./hours.mts"
import { Published, carried, publish } from "./publish.mts"
import { PUBLIC, isKept, keepServed } from "../files.mts"
import { deployed, served } from "../site.mts"

const API = "https://unh.api.nutrislice.com/menu/api"
const INDEX = new URL("../../src/dining/menus.json", import.meta.url)
const FILES = new URL(`.${DATA_PATH}`, PUBLIC)
const PUBLISHED = `${DATA_PATH}published.json`
const WEEKS = 3

if (await isKept(INDEX))
  process.exit(0)

// Durham's, as UTC's is already tomorrow by a summer evening
const today = localDay(Date.now())

// A school, its hours taken as they come, as nutrisliceHours reads them for what they turn out to be
const School = v.intersect([
  objectOf<NutrisliceSchool>(),
  v.object({ slug: v.string(), name: v.string(), active_menu_types: v.array(v.object({ slug: v.string() })) })
])

// Dining halls are the schools serving meals, unlike stadium concessions
const halls = (await getJson(`${API}/schools/`, { schema: v.array(School) }))
  .map(school => ({
    id: school.slug,
    name: school.name.replace(/^Dining - /, "").replace(/ Menus$/, ""),
    meals: school.active_menu_types.map(type => type.slug).filter(meal => MEALS.includes(meal)),
    school
  }))
  .filter(hall => hall.meals.length)

const weeks = await Promise.all(
  halls.flatMap(hall =>
    hall.meals.flatMap(meal =>
      Array.from({ length: WEEKS }, async (_, week) => ({
        hall: hall.id,
        meal,
        week: await getJson(`${API}/weeks/school/${hall.id}/menu-type/${meal}/${addDays(today, week * 7).replaceAll("-", "/")}/`, { schema: NutrisliceWeek })
      }))
    )
  )
)

// Hours help but aren't the point, so a hall whose hours can't be read just goes without them
const hours: MenusIndex["hours"] = {}
await Promise.all(halls.map(async ({ id, school }) => {
  const page = UNH_PAGES[id] && `https://www.unh.edu/dining/facility/${UNH_PAGES[id]}`
  const unh = page
    ? await fetch(page)
        .then(response => response.ok ? response.text() : Promise.reject(new Error(`${response.status}`)))
        .then(parseUnhHours)
        .catch(error => void console.warn(`Couldn't load ${page}: ${error.message}`))
    : undefined
  if (!unh)
    console.warn(`No hours from UNH Dining for ${id}, so using Nutrislice's`)
  const found = hallHours(unh, nutrisliceHours(school), today)
  if (found)
    hours[id] = found
  else
    console.warn(`No hours for ${id}`)
}))

const data = convert(halls.map(({ id, name }) => ({ id, name })), weeks, Date.now(), today)
// Nothing posted at all is a Nutrislice problem, not a quiet week, so failing keeps the last menus up
if (!data.menus.length)
  throw new Error("Nutrislice has no menus posted")

// The index goes last, so it only ever names files that are there, and the files published before stay as long as
// a tab still on an index naming them may ask (publish.mts), fetched back from the site since a build starts from
// nothing, with the record of them beside them for the next build
const { index, files } = publish(data, hours)
const [serving, published] = await Promise.all([deployed("/dining/", "menus", MenusIndex), served(PUBLISHED, Published)])
const carrying = carried(serving, published, index, Date.now())
await rm(FILES, { recursive: true, force: true })
await mkdir(FILES, { recursive: true })
await Promise.all([...files].map(([name, json]) => writeFile(new URL(`${name}.json`, FILES), json)))
const kept = await keepServed(Object.keys(carrying))
await writeFile(new URL(`.${PUBLISHED}`, PUBLIC), JSON.stringify(Object.fromEntries(kept.map(url => [url, carrying[url]]))))
await writeFile(INDEX, JSON.stringify(index))
const days = [...new Set(data.menus.map(menu => menu.day))]
console.log(`Wrote ${data.halls.length} halls (${Object.keys(hours).length} with hours), ${data.foods.length} foods, ${data.menus.length} meals (${days[0]}–${days.at(-1)}) in ${files.size} files, keeping ${kept.length} published before`)
