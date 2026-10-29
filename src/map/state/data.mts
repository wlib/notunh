// The map's bundled data, and what's derived from it: reactive values only, no DOM

import { r } from "bruh/reactive"
import { boardableStops, loadFeed } from "../../transit/feed.mts"
import { Model, emptyModel } from "../../transit/models/model.mts"
import { WalkData, loadGraph } from "../../routing/graph.mts"
import { createWalks } from "../../routing/walks.mts"
import { Places } from "../../places/buildings.mts"
import { Gazetteer } from "../../places/gazetteer.mts"
import { createPlaceSearch } from "../../places/search.mts"
import { CHAPTERS, aliasesOf, isPlaced } from "../../places/chapters.mts"
import { loadStyle } from "../basemap/style.mts"
import { TilesManifest } from "../basemap/tiles.mts"
import { EventsData } from "../../social/event.mts"
import { CoursesIndex, emptyIndex } from "../../courses/course.mts"
import { NO_PREREQS, PrereqsIndex } from "../../programs/prereqs.mts"
import { NO_PARKING, ParkingData } from "../../parking/sources.mts"
import { MenusIndex } from "../../dining/menus.mts"
import { NO_ROOMS, RoomsData } from "../../courses/bookings.mts"
import { latest } from "../../shell/build.mts"

/** The middle of campus, which search prefers the nearer of two places by one name to */
const CAMPUS = { lat: 43.1365, lon: -70.9345 }

/** The other names of the places that go by more than one: the chapters' houses, by their letters and nicknames */
const ALIASES = new Map(CHAPTERS.filter(isPlaced).map(chapter => [chapter.name, aliasesOf(chapter)]))

/**
 * The bundled data, loaded, each swapped for a newer build's as it comes, which everything derived from it follows.
 * The map works without a model or today's events, so it starts with an empty one of either that can't load
 */
export const loadMapData = async () => {
  const [feed, model, network, gazetteerData, tiles, style, places, events, rooms, coursesIndex, prereqsIndex, parking, menus] = await Promise.all([
    latest("gtfs", loadFeed),
    latest("model", Model, emptyModel),
    latest("walk", WalkData),
    latest("gazetteer", Gazetteer),
    latest("tiles", TilesManifest),
    latest("style", loadStyle),
    latest("places", Places),
    // The map works without today's events, so it starts with none if they can't load
    latest("events", EventsData, (): EventsData => ({ fetched: 0, events: [] })),
    // The rooms to book and the week's bookings as of the build, which the Worker's newer word is merged over (rooms.mts)
    latest("rooms", RoomsData, () => NO_ROOMS),
    // The indexes alone, which name the term files and the prerequisites loaded once something asks (state/courses.mts),
    // and the parking areas, which are as small
    latest("courses", CoursesIndex, emptyIndex),
    latest("prereqs", PrereqsIndex, () => NO_PREREQS),
    latest("parking", ParkingData, () => NO_PARKING),
    // The dining halls' hours, for their places' pages; the map works without them
    latest("menus", MenusIndex, (): MenusIndex => ({ fetched: 0, halls: [], hours: {}, diets: [], contains: [], days: {}, search: "", files: [] }))
  ])
  const graph = r(() => loadGraph(network.value))
  const gazetteer = r(() => gazetteerData.value.places)
  const buildings = r(() => places.value.buildings)
  const walks = r(() => createWalks(feed.value.stops, graph.value, gazetteer.value))

  /** Places by name, laundry and dining first, then the stops buses pick up at, then the rest of Durham */
  const searchPlaces = r(() => {
    const boardable = boardableStops(feed.value)
    return createPlaceSearch([
      ...buildings.value.map(({ lat, lon, name }) => ({ lat, lon, name })),
      ...feed.value.stops.filter((_, i) => boardable.has(i)).map(({ lat, lon, name }) => ({ lat, lon, name })),
      ...gazetteer.value.map(({ name, at: [lon, lat] }) => ({ lat, lon, name }))
    ], CAMPUS, ALIASES)
  })
  return { feed, model, tiles, style, gazetteer, buildings, walks, searchPlaces, events, rooms, coursesIndex, prereqsIndex, parking, menus }
}

export type MapData = Awaited<ReturnType<typeof loadMapData>>
