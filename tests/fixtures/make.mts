// Makes the fixtures under data/ from the inputs and map data installed (by `npm run dev`, then `npm run fixtures`).
// They're small, real-shaped copies of every file upstream would give, laid out as the repository is. Offline builds
// install them in place of the inputs and map data (scripts/inputs.mts). The timetable is cut to the campus
// connectors, and the menus to each hall's first two days and each meal's first two stations. The models are empty, and the style is Liberty as the tests
// have it, with no sprite or fonts. The walk, gazetteer, and rooms are whole. The events, the courses, the
// prerequisites, the parking areas and the rooms to book are made as the inputs make them, from the trimmed answers
// beside the data (../events/, ../courses/ with its made-up addresses, ../programs/, ../parking/ and ../rooms/), as
// of one fixed day, so they're the same whenever they're made

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { gunzipSync } from "node:zlib"
import type { StyleSpecification } from "maplibre-gl"
import type { FeedData } from "../../src/transit/feed.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { type Food, type Meal, type MenusData, type MenusIndex, DATA_PATH } from "../../src/dining/menus.mts"
import { bundle as bundleUsual, emptyLearned } from "../../src/laundry/model.mts"
import { publish } from "../../scripts/dining/publish.mts"
import { bundle } from "../../scripts/map/style.mts"
import { FIXTURES } from "../../scripts/files.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { EVENTS, REC_PROGRAMS, from25Live, fromAthletics, fromDserec, fromPresence, fromRecOfferings, merged, programOf } from "../../src/social/sources.mts"
import { COURSES } from "../../src/courses/course.mts"
import { fromLive25 } from "../../src/courses/calendar.mts"
import { placeOfCode } from "../../src/courses/buildings.mts"
import { Page, importTerm, pageRead } from "../../src/courses/registrar.mts"
import { publish as publishCourses } from "../../scripts/map/courses.mts"
import { prerequisitesOf } from "../../src/programs/catalog.mts"
import { PREREQS } from "../../src/programs/prereqs.mts"
import { publishPrereqs, readPages, readPrograms } from "../../scripts/programs/prereqs.mts"
import { withTitles } from "../../src/programs/requirements.mts"
import { PARKING } from "../../src/parking/sources.mts"
import { cached, parkingOf } from "../../scripts/map/parking.mts"
import { ROOMS, bookingsFrom, shownTo, spacesFrom } from "../../src/courses/bookings.mts"
import { facilitiesFrom, recBookingsFrom } from "../../src/courses/rec.mts"

const REPO = new URL("../../", import.meta.url)
const ROUTES = ["Gables", "WestEdge"]
const DAYS = 2
const STATIONS = 2
/** The day the fixtures are as of, Saturday 24 October 2026 */
const MADE = Date.UTC(2026, 9, 24)
/** The day of bookings the rooms' fixtures keep, and Campus Rec's facilities whose schedules they keep, by file */
const ROOMS_DAY = "2026-10-28"
const REC = { westgym: "d949aebc-c63a-4440-bb87-beda6b2ce438", court1: "b78ab042-f000-4b3a-b36a-1a147cbc5ad6", bremner: "82626de1-7fb2-4d95-a83d-8f86f8462ba2" }
/** The registrar's terms the fixtures have answers for: Fall 2026, J-Term and Spring 2027 */
const TERMS = ["202610", "202630", "202650"]

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

const fixture = (path: string) =>
  readFile(new URL(`../${path}`, FIXTURES), "utf8")

// The events, read from the calendars' trimmed answers as the build reads the whole ones, placed as the build places
// them, on the gazetteer with the places added to it
const gazetteer = v.parse(Gazetteer, await read("src/map/gazetteer.json"))
const names = gazetteer.places.map(place => place.name)
const match = placeMatcher(names)
const program = { id: REC_PROGRAMS[3], ...programOf(await fixture("events/rec-program.html")) }
const events = merged([fromPresence(JSON.parse(await fixture("events/presence.json")), match), from25Live(JSON.parse(await fixture("events/25live.json")), match), fromAthletics(await fixture("events/athletics.ics"), match), fromDserec(JSON.parse(await fixture("events/dserec.json")), match), fromRecOfferings(await fixture("events/rec-offerings.html"), program, program.semesters[0].name, match)], 0)
await write(EVENTS, { fetched: MADE, events })

// The rooms to book, read from 25Live's trimmed answers as the build reads the whole ones, with their NetIDs and
// titles made up: the spaces placed, and the one day of bookings kept, as anyone is told them
// and Campus Rec's facilities, with the week of the West Gym, its Court 1 and Bremner Field kept (../rec/)
const facilities = facilitiesFrom(await fixture("rec/schedule.html"), match)
const spaces = [...spacesFrom(JSON.parse(await fixture("rooms/spaces.json")), match), ...facilities]
const placed = new Set(spaces.map(({ id }) => id))
const rec = await Promise.all(Object.entries(REC).map(async ([name, id]) => recBookingsFrom(JSON.parse(await fixture(`rec/${name}.json`)), id, ROOMS_DAY, ROOMS_DAY)))
const bookings = shownTo([...bookingsFrom(JSON.parse(await fixture("rooms/reservations.json"))), ...rec.flat()], false).filter(({ space }) => placed.has(space))
await write(ROOMS, { fetched: MADE, spaces, days: [{ day: ROOMS_DAY, fetched: MADE, bookings }] })

// The courses, each term's answer read a hundred rows a page as the API gives them, published as of that day: Fall
// live, J-Term and Spring to come
const place = placeOfCode(new Set(names))
const imported = await Promise.all(TERMS.map(async code => {
  const page = v.parse(Page, JSON.parse(await fixture(`courses/courses-${code}.json`)))
  const pages = Array.from({ length: Math.ceil(page.data.length / 100) }, (_, i) => pageRead({ ...page, data: page.data.slice(i * 100, i * 100 + 100) }, MADE))
  return importTerm(code, pages, place)
}))
const courses = await publishCourses(imported, fromLive25(JSON.parse(await fixture("courses/25live.json")), MADE), MADE)
await write(COURSES, courses.index)
for (const [file, json] of courses.files)
  await write(`public${file}`, JSON.parse(json))

// The prerequisites of the subjects whose catalog pages are kept, and the programs whose pages are
const { pages } = await readPages(fileURLToPath(new URL("../programs/", FIXTURES)))
const { data: prereqsData } = prerequisitesOf(pages, MADE)
const titles = new Map(pages.flatMap(page => page.courses.map(course => [course.code, course.title] as const)))
const programs = withTitles(await readPrograms(fileURLToPath(new URL("../programs/programs/", FIXTURES))), prereqsData, titles)
const prereqs = await publishPrereqs(prereqsData, programs)
await write(PREREQS, prereqs.index)
for (const [file, json] of prereqs.files)
  await write(`public${file}`, JSON.parse(json))

// The parking areas, checked against the copies of their sources kept
await write(PARKING, (await parkingOf(await cached(), MADE)).data)

await write("src/laundry/rooms.json", await read("src/laundry/rooms.json"))
await write("src/laundry/usual.json", bundleUsual(emptyLearned()))

console.log(`Fixtures in ${FIXTURES.pathname}: ${ROUTES.length} routes, ${menus.files.size} dining files for ${DAYS} days a hall, ${events.length} events, ${courses.index.terms.length} terms, ${Object.keys(prereqsData.courses).length} courses' prerequisites, ${programs.length} programs`)
