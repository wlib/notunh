// Makes the fixtures under data/ from the data a build fetched (`npm run data`, then `npm run fixtures`): small,
// real-shaped copies of every file upstream would give, laid out as the repository is, which offline builds take in
// place of fetching (scripts/data.mts) and which the walk and gazetteer fall back on while there's no map data
// release. The timetable is cut to the campus connectors, the menus to each hall's first two days and their first
// stations, the models are empty, the style is Liberty as the tests have it with no sprite or fonts, and the walk,
// gazetteer, and rooms are whole

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { gunzipSync } from "node:zlib"
import type { StyleSpecification } from "maplibre-gl"
import type { FeedData } from "../../src/transit/feed.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { type Food, type Meal, type MenusData, type MenusIndex, DATA_PATH } from "../../src/dining/menus.mts"
import { bundle as bundleUsual, emptyLearned } from "../../src/laundry/model.mts"
import { publish } from "../../scripts/dining/publish.mts"
import { bundle } from "../../scripts/map/style.mts"
import { FIXTURES } from "../../scripts/files.mts"

const REPO = new URL("../../", import.meta.url)
const ROUTES = ["Gables", "WestEdge"]
const DAYS = 2
const STATIONS = 2

const read = async <T,>(path: string): Promise<T> =>
  JSON.parse(await readFile(new URL(path, REPO), "utf8"))

const write = async (path: string, value: unknown) => {
  const file = new URL(path, FIXTURES)
  await mkdir(new URL(".", file), { recursive: true })
  await writeFile(file, JSON.stringify(value) + "\n")
}

/** Some of the feed's routes, with only the trips, stops, services, and shapes they use, stops renumbered */
const fewerRoutes = (feed: FeedData, ids: string[]): FeedData => {
  const kept = new Set(ids)
  const routes = feed.routes.filter(route => kept.has(route.id))
  const trips = feed.trips.filter(trip => kept.has(trip.route))
  const stops = [...new Set(trips.flatMap(trip => trip.stops))].sort((a, b) => a - b)
  const renumbered = new Map(stops.map((stop, i) => [stop, i]))
  return {
    ...feed,
    routes,
    stops:    stops.map(stop => feed.stops[stop]),
    services: Object.fromEntries(Object.entries(feed.services).filter(([id]) => trips.some(trip => trip.service === id))),
    trips:    trips.map(trip => ({ ...trip, stops: trip.stops.map(stop => renumbered.get(stop)!) })),
    shapes:   Object.fromEntries(Object.entries(feed.shapes).filter(([id]) => trips.some(trip => trip.shape === id)))
  }
}

/**
 * Each hall's first days of menus, their first stations, back as the data they were published from, each food read
 * once and in the order served, so the fixtures come out the same every time
 */
const fewerDays = async (index: MenusIndex, count: number, perMeal: number): Promise<MenusData> => {
  const foods: Food[] = []
  const indexOf = new Map<string, number>()
  const menus: MenusData["menus"] = []
  for (const [hall, days] of Object.entries(index.days))
    for (const [day, { file }] of Object.entries(days).sort().slice(0, count))
      for (const { meal, stations: all } of await read<Meal[]>(`public${DATA_PATH}${file}.json`)) {
        const stations: MenusData["menus"][number]["stations"] = []
        for (const station of all.slice(0, perMeal)) {
          for (const { file } of station.foods)
            if (!indexOf.has(file))
              indexOf.set(file, foods.push(await read<Food>(`public${DATA_PATH}${file}.json`)) - 1)
          stations.push({ name: station.name, foods: station.foods.map(({ file }) => indexOf.get(file)!) })
        }
        menus.push({ hall, day, meal, stations })
      }
  return { fetched: index.fetched, halls: index.halls, foods, menus }
}

await rm(FIXTURES, { recursive: true, force: true })

await write("src/map/gtfs.json", fewerRoutes(await read("src/map/gtfs.json"), ROUTES))
await write("src/map/model.json", emptyModel())
await write("src/map/tiles.json", {})
await write("src/map/walk.json", await read("src/map/walk.json"))
await write("src/map/gazetteer.json", await read("src/map/gazetteer.json"))

// The style as the build makes it, in a folder named by its hash as the build names it, without its sprite and fonts
const liberty: StyleSpecification = JSON.parse(gunzipSync(await readFile(new URL("../map/fixtures/liberty.json.gz", import.meta.url))).toString())
const style = await bundle(liberty, { tiles: ["https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf"] }, [])
for (const [path, json] of style.files)
  await write(`public${style.folder}${path}`, JSON.parse(json as string))
await write("src/map/style.json", style.manifest)

const index = await read<MenusIndex>("src/dining/menus.json")
const menus = await publish(await fewerDays(index, DAYS, STATIONS), index.hours)
await write("src/dining/menus.json", menus.index)
for (const [name, json] of menus.files)
  await write(`public${DATA_PATH}${name}.json`, JSON.parse(json))

await write("src/laundry/rooms.json", await read("src/laundry/rooms.json"))
await write("src/laundry/usual.json", bundleUsual(emptyLearned()))

console.log(`Fixtures in ${FIXTURES.pathname}: ${ROUTES.length} routes, and ${menus.files.size} dining files for ${DAYS} days a hall`)
