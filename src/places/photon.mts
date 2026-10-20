// Komoot's Photon geocoder, over OpenStreetMap, for what the gazetteer doesn't know: addresses, and places beyond
// Durham

import * as v from "valibot"
import type { Place } from "./search.mts"
import type { Box } from "../geo/boxes.mts"
import { getJson, usable } from "../shared/json.mts"

const PHOTON = "https://photon.komoot.io"

// Durham, Dover, and Portsmouth
const BIAS = { lat: 43.14, lon: -70.88 }
const BOUNDS = [-71.05, 43.0, -70.70, 43.30]

/** The slice of a Photon feature we read; an answer keeps only the features that fit */
const Feature = v.object({
  geometry:   v.object({ coordinates: v.tuple([v.number(), v.number()]) }),
  properties: v.object({
    name:        v.optional(v.string()),
    street:      v.optional(v.string()),
    housenumber: v.optional(v.string()),
    city:        v.optional(v.string()),
    district:    v.optional(v.string()),
    osm_key:     v.optional(v.string()),
    osm_value:   v.optional(v.string()),
    /** West, north, east, south, for areas like buildings */
    extent:      v.optional(v.tuple([v.number(), v.number(), v.number(), v.number()]))
  })
})
type Feature = v.InferOutput<typeof Feature>

const Answer = v.object({ features: usable(Feature) })

const photon = async (path: string, params: Record<string, string>, signal?: AbortSignal) => {
  const { features } = await getJson(`${PHOTON}${path}?${new URLSearchParams({ lang: "en", ...params })}`, { schema: Answer, signal })
  return features
}

const addressOf = ({ properties }: Feature) =>
  [properties.housenumber, properties.street].filter(Boolean).join(" ")

/** Places by name or address, nearest Durham first */
export const search = async (query: string, signal?: AbortSignal): Promise<Place[]> => {
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

/** The named things around a point, by their OpenStreetMap tag, and the address of the building there */
export const reverse = async ({ lat, lon }: { lat: number, lon: number }) => {
  const features = await photon("/reverse", { lat: lat + "", lon: lon + "", limit: "15", radius: "0.2" })
  const places = features.flatMap(({ geometry, properties: { name, osm_key, osm_value, extent } }) => {
    if (!name || !osm_key || !osm_value)
      return []
    const [west, north, east, south] = extent ?? []
    return [{ name, key: osm_key, value: osm_value, at: geometry.coordinates, extent: extent && [west, south, east, north] as Box }]
  })
  const address = features.find(feature => feature.properties.housenumber && feature.properties.osm_key === "building")
  return { places, address: address && addressOf(address) }
}
