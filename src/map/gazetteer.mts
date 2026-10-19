// The gazetteer: the places OpenStreetMap names around Durham, as scripts/map/osm.mts saves them, with the doors of
// its buildings. The map searches it, names taps by it, and walks to buildings' doors by it, and reads Photon's
// answers into the same shape for anywhere else

import * as v from "valibot"
import { type Box, area, holds, outlineHolds } from "../geo/boxes.mts"
import { type Coordinates, type Point, distance } from "../geo/projection.mts"
import * as photon from "./photon.mts"
import { arrayOf } from "../shared/json.mts"
import { Made } from "./made.mts"

export type GazetteerPlace = {
  name: string,
  /** "building", or what else OpenStreetMap tags it as, like "cafe" or "park" */
  kind: string,
  /** Its middle, as lon, lat */
  at: Coordinates,
  /** How far it spreads, for a place with an outline */
  extent?: Box,
  /** A building's outline, as rings of lon, lat, for telling what's inside it from what's in its courtyard or an L's corner */
  outline?: Coordinates[][],
  /** A building's doors, as lon, lat */
  entrances?: Coordinates[]
}

/** The gazetteer as the map's page loads it: every place, and where they came from */
export const Gazetteer = v.object({ made: Made, places: arrayOf<GazetteerPlace>() })
export type Gazetteer = v.InferOutput<typeof Gazetteer>

// The keys tagging the kinds of things people mean by a tap or a search, rather than the bench or path beside it,
// though not the art on a wall
export const PLACE_KEYS = ["building", "amenity", "shop", "office", "leisure", "tourism", "craft", "healthcare"]
const NOT_PLACES = new Set(["artwork"])

/** The kind of place a tag makes something, if it's a place at all */
export const kindOf = (key: string, value: string) =>
  key === "building"                                 ? "building" :
  PLACE_KEYS.includes(key) && !NOT_PLACES.has(value) ? value :
                                                       undefined

// Further than this from a tap, a place isn't what was tapped
const MAX_NEARBY = 60 // m

/** The buildings a point is in, by their outlines where the gazetteer has them, smallest first */
export const buildingsAt = (places: readonly GazetteerPlace[], point: Point) =>
  places
    .filter(place => place.kind === "building" && place.extent && holds(place.extent, point) && (!place.outline || outlineHolds(place.outline, point)))
    .sort((a, b) => area(a.extent!) - area(b.extent!))

/**
 * The place a point is in or beside: the building it's in, first one whose middle is within the outline the map
 * draws there, else the nearest place within MAX_NEARBY
 */
export const placeAt = (places: readonly GazetteerPlace[], point: Point, outline?: MapHints["outline"]) => {
  const within = buildingsAt(places, point)
  const nearby = places
    .map(place => ({ place, meters: distance(point, { lon: place.at[0], lat: place.at[1] }) }))
    .filter(({ meters }) => meters <= MAX_NEARBY)
    .sort((a, b) => a.meters - b.meters)
  return (
    (outline && within.find(({ at: [lon, lat] }) => outlineHolds(outline, { lat, lon }))) ??
    within[0] ??
    nearby[0]?.place
  )
}

/** What the map itself shows where someone tapped */
export type MapHints = {
  /** A label drawn right there */
  label?: string,
  /** The outline of the building tapped, as rings */
  outline?: Coordinates[][],
  /** The address of the building tapped */
  address?: string
}

/**
 * The name of a spot: what the map labels there, else the place it's in or beside, else the address the map has
 * for it, else what Photon knows of it, for beyond the gazetteer
 */
export const nameAt = async (places: readonly GazetteerPlace[], point: Point, hints: MapHints = {}) => {
  const named = hints.label ?? placeAt(places, point, hints.outline)?.name ?? hints.address
  if (named)
    return named
  const found = await photon.reverse(point).catch(() => undefined)
  if (!found)
    return undefined
  const around = found.places.flatMap(({ key, value, ...place }) => {
    const kind = kindOf(key, value)
    return kind ? [{ ...place, kind }] : []
  })
  return placeAt(around, point, hints.outline)?.name ?? found.address
}
