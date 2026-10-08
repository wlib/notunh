// Public OSM services: FOSSGIS's OSRM foot router and Komoot's Photon geocoder

import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon"
import { distance } from "./feed.mts"
import type { Place } from "./plan.mts"
import { getJson } from "../shared/json.mts"

const FOOT_ROUTER = "https://routing.openstreetmap.de/routed-foot/route/v1/foot"
const PHOTON = "https://photon.komoot.io"

// Durham, Dover, and Portsmouth
const BIAS = { lat: 43.14, lon: -70.88 }
const BOUNDS = [-71.05, 43.0, -70.70, 43.30]

const walkCache = new Map<string, Promise<[number, number][]>>()

/** Street geometry for a walk, falling back to a straight line */
export const walkPath = (from: Place, to: Place) => {
  const round = (x: number) => x.toFixed(5)
  const key = `${round(from.lon)},${round(from.lat)};${round(to.lon)},${round(to.lat)}`
  const straight: [number, number][] = [[from.lon, from.lat], [to.lon, to.lat]]

  let path = walkCache.get(key)
  if (!path) {
    path = getJson<{ routes?: { geometry: { coordinates: [number, number][] } }[] }>(`${FOOT_ROUTER}/${key}?overview=full&geometries=geojson`)
      .then(result => result.routes?.[0]?.geometry.coordinates ?? straight)
      .catch(() => straight)
    walkCache.set(key, path)
  }
  return path
}

type PhotonFeature = {
  geometry: { coordinates: [number, number] },
  properties: {
    name?:        string,
    street?:      string,
    housenumber?: string,
    city?:        string,
    district?:    string,
    osm_key?:     string,
    osm_value?:   string,
    /** [west, north, east, south], for areas like buildings */
    extent?:      [number, number, number, number]
  }
}

const photon = async (path: string, params: Record<string, string>, signal?: AbortSignal) => {
  const { features } = await getJson<{ features: PhotonFeature[] }>(`${PHOTON}${path}?${new URLSearchParams({ lang: "en", ...params })}`, { signal })
  return features
}

const addressOf = ({ properties }: PhotonFeature) =>
  [properties.housenumber, properties.street].filter(Boolean).join(" ")

export const searchPlaces = async (query: string, signal?: AbortSignal): Promise<Place[]> => {
  const features = await photon("/api/", {
    q: query,
    lat: BIAS.lat + "",
    lon: BIAS.lon + "",
    bbox: BOUNDS.join(","),
    limit: "6"
  }, signal)

  const places = features.map(feature => {
    const area = feature.properties.city ?? feature.properties.district
    return {
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
      name: [feature.properties.name ?? addressOf(feature), area].filter(Boolean).join(", ")
    }
  })
  // OSM often has a building as both a way and a relation
  return [...new Map(places.map(place => [place.name, place])).values()]
}

/** What the map itself shows where someone tapped */
export type MapHints = {
  /** A label drawn right there */
  label?: string,
  /** The outline of the building tapped */
  outline?: GeoJSON.Polygon | GeoJSON.MultiPolygon
}

// The kinds of things people mean when they tap a spot, rather than the bench or path beside it
const PLACE_KEYS = new Set(["building", "amenity", "shop", "office", "leisure", "tourism", "craft", "healthcare"])
const MAX_NEARBY = 60 // m

const contains = ([west, north, east, south]: [number, number, number, number], lat: number, lon: number) =>
  west <= lon && lon <= east && south <= lat && lat <= north

const area = ([west, north, east, south]: [number, number, number, number]) =>
  (east - west) * (north - south)

/** The name of a tapped spot: what the map labels there, else the place it's in or beside, else an address */
export const nameAt = async ({ lat, lon }: { lat: number, lon: number }, hints: MapHints = {}) => {
  if (hints.label)
    return hints.label

  const features = await photon("/reverse", { lat: lat + "", lon: lon + "", limit: "15", radius: "0.2" })
    .catch(() => [])
  const places = features.filter(({ properties }) =>
    properties.name &&
    PLACE_KEYS.has(properties.osm_key!) &&
    properties.osm_value !== "artwork"
  )

  // The smallest place whose outline holds the tap: the building, not the campus around it
  const { outline } = hints
  const within = places
    .filter(({ geometry, properties }) =>
      properties.extent
        ? contains(properties.extent, lat, lon)
        : outline !== undefined && booleanPointInPolygon(geometry.coordinates, outline)
    )
    .sort((a, b) => area(a.properties.extent ?? [0, 0, 0, 0]) - area(b.properties.extent ?? [0, 0, 0, 0]))

  const nearby = places.find(({ geometry: { coordinates: [placeLon, placeLat] } }) =>
    distance({ lat, lon }, { lat: placeLat, lon: placeLon }) <= MAX_NEARBY
  )
  const address = features.find(feature => feature.properties.housenumber && feature.properties.osm_key === "building")

  return (
    within[0]?.properties.name ??
    nearby?.properties.name ??
    (address && addressOf(address))
  )
}
