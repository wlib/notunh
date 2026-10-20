import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { gazetteerOf, middleOf } from "../../scripts/map/gazetteer.mts"
import type { OsmElement } from "../../scripts/map/pbf.mts"
import { type GazetteerPlace, buildingsAt, nameAt, placeAt } from "../../src/places/gazetteer.mts"
import type { Box } from "../../src/geo/boxes.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

afterEach(() => vi.unstubAllGlobals())

/** A rectangle's corners, some degrees across, going round from one of them */
const rectangle = (west: number, south: number, east: number, north: number, from = 0) =>
  [[west, south], [east, south], [east, north], [west, north]]
    .map((_, i, corners) => corners[(i + from) % 4])
    .map(([lon, lat]) => ({ lat, lon }))

const bounds = (west: number, south: number, east: number, north: number): Box =>
  [west, south, east, north]

test("a rectangle's middle is its center, whichever corner its outline starts from", () =>
  fc.assert(fc.property(
    fc.double({ min: -1e-3, max: 1e-3, noNaN: true }),
    fc.double({ min: -1e-3, max: 1e-3, noNaN: true }),
    fc.double({ min: 1e-5, max: 1e-3, noNaN: true }),
    fc.double({ min: 1e-5, max: 1e-3, noNaN: true }),
    fc.nat(3),
    (x, y, width, height, from) => {
      const [west, south] = [CENTER.lon + x, CENTER.lat + y]
      const { lat, lon } = middleOf({ geometry: rectangle(west, south, west + width, south + height, from) })
      expect(lon).toBeCloseTo(west + width / 2, 9)
      expect(lat).toBeCloseTo(south + height / 2, 9)
    }
  ))
)

test("the gazetteer has named places and buildings, each building with its outline and the doors on it people walk through", () => {
  const [west, south, east, north] = [-70.931, 43.134, -70.929, 43.136]
  const outline = rectangle(west, south, east, north)
  const door = (id: number, { lat, lon }: { lat: number, lon: number }, entrance: string): OsmElement =>
    ({ type: "node", id, lat, lon, tags: { entrance } })
  const elements: OsmElement[] = [
    { type: "way", id: 1, nodes: [11, 12, 13, 14, 11], tags: { building: "university", name: "Kingsbury Hall", amenity: "library" }, geometry: [...outline, outline[0]], bounds: bounds(west, south, east, north) },
    door(11, outline[0], "main"),
    door(12, outline[1], "yes"),
    door(13, outline[2], "emergency"),
    // A door of some other building, which no named building has
    door(15, { lat: 43.2, lon: -70.9 }, "yes"),
    {
      type: "relation", id: 2, tags: { building: "yes", name: "Paul Creative Arts Center" }, bounds: bounds(-70.94, 43.13, -70.938, 43.132),
      members: [{ type: "way", ref: 3, role: "outer", geometry: [{ lat: 43.13, lon: -70.94 }, { lat: 43.132, lon: -70.938 }] }]
    },
    door(16, { lat: 43.132, lon: -70.938 }, "yes"),
    { type: "node", id: 20, ...CENTER, tags: { amenity: "cafe", name: "Zeke's" } },
    { type: "node", id: 21, ...CENTER, tags: { tourism: "artwork", name: "A Sculpture" } },
    { type: "node", id: 22, ...CENTER, tags: { amenity: "bench" } },
    { type: "way", id: 23, nodes: [], tags: { building: "yes" }, geometry: outline, bounds: bounds(west, south, east, north) }
  ]
  expect(gazetteerOf(elements)).toEqual([
    {
      name: "Kingsbury Hall",
      kind: "building",
      at: [-70.93, 43.135],
      extent: [west, south, east, north],
      outline: [[[west, south], [east, south], [east, north], [west, north]]],
      entrances: [[west, south], [east, south]]
    },
    {
      name: "Paul Creative Arts Center",
      kind: "building",
      at: [-70.939, 43.131],
      extent: [-70.94, 43.13, -70.938, 43.132],
      entrances: [[-70.938, 43.132]]
    },
    { name: "Zeke's", kind: "cafe", at: [CENTER.lon, CENTER.lat] }
  ])
})

const HALL: GazetteerPlace = { name: "Hall", kind: "building", at: [-70.93, 43.135], extent: [-70.931, 43.134, -70.929, 43.136] }
// A smaller building in a corner of the hall's extent, though not within its outline
const ANNEX: GazetteerPlace = { name: "Annex", kind: "building", at: [-70.9305, 43.1345], extent: [-70.931, 43.134, -70.93, 43.135] }
// A cafe some 40 m east of the hall, and a park around them all
const CAFE: GazetteerPlace = { name: "Cafe", kind: "cafe", at: [-70.9285, 43.1352] }
const PARK: GazetteerPlace = { name: "Park", kind: "park", at: [-70.93, 43.135], extent: [-70.94, 43.13, -70.92, 43.14] }
const PLACES = [PARK, CAFE, HALL, ANNEX]

/** Photon answering a reverse lookup with some features, and how often it was asked */
const photonAnswers = (features: object[]) => {
  const asked = vi.fn(async () => Response.json({ features }))
  vi.stubGlobal("fetch", asked)
  return asked
}

test("a spot in a building's courtyard, or in the corner its outline leaves out, isn't in it", () => {
  // A square building with a square courtyard, and an L next to it
  const ring = (west: number, south: number, east: number, north: number): [number, number][] =>
    [[west, south], [east, south], [east, north], [west, north]]
  const court: GazetteerPlace = { ...HALL, name: "Court", outline: [ring(-70.931, 43.134, -70.929, 43.136), ring(-70.9305, 43.1345, -70.9295, 43.1355)] }
  const ell: GazetteerPlace = {
    name: "L", kind: "building", at: [-70.92, 43.135], extent: [-70.921, 43.134, -70.919, 43.136],
    outline: [[[-70.921, 43.134], [-70.919, 43.134], [-70.919, 43.135], [-70.92, 43.135], [-70.92, 43.136], [-70.921, 43.136]]]
  }
  expect(buildingsAt([court, ell], { lat: 43.1352, lon: -70.9308 })).toEqual([court])
  expect(buildingsAt([court, ell], { lat: 43.135, lon: -70.93 })).toEqual([])
  expect(buildingsAt([court, ell], { lat: 43.1345, lon: -70.9195 })).toEqual([ell])
  expect(buildingsAt([court, ell], { lat: 43.1355, lon: -70.9195 })).toEqual([])
})

test("a spot is named for the smallest building it's in, unless the map's outline holds another's middle", () => {
  const spot = { lat: 43.1349, lon: -70.9301 }
  expect(placeAt(PLACES, spot)).toBe(ANNEX)
  // The hall drawn around the spot and its own middle, but not the annex's
  const hall = [[[-70.9303, 43.1347], [-70.929, 43.1347], [-70.929, 43.136], [-70.9303, 43.136], [-70.9303, 43.1347]]] as [number, number][][]
  expect(placeAt(PLACES, spot, hall)).toBe(HALL)
})

test("outside every building a spot is named for the nearest place within 60 m, and a park around it isn't one", () => {
  expect(placeAt(PLACES, { lat: 43.1352, lon: -70.928 })).toBe(CAFE)
  expect(placeAt(PLACES, { lat: 43.1352, lon: -70.92785 })).toBe(CAFE)
  expect(placeAt(PLACES, { lat: 43.1352, lon: -70.9277 })).toBeUndefined()
})

test("a spot is named by the map's label, then the gazetteer, then the map's address, and only then by Photon", async () => {
  const asked = photonAnswers([])
  const inHall = { lat: 43.1355, lon: -70.9295 }
  const nowhere = { lat: 43.2, lon: -70.8 }
  expect(await nameAt(PLACES, inHall, { label: "Label", address: "1 Main Street" })).toBe("Label")
  expect(await nameAt(PLACES, inHall, { address: "1 Main Street" })).toBe("Hall")
  expect(await nameAt(PLACES, nowhere, { address: "1 Main Street" })).toBe("1 Main Street")
  expect(asked).not.toHaveBeenCalled()
  expect(await nameAt(PLACES, nowhere)).toBeUndefined()
  expect(asked).toHaveBeenCalledOnce()
})

test("Photon names a spot beyond the gazetteer by the building it's in, else a place beside it, else its address", async () => {
  const nowhere = { lat: 43.2, lon: -70.8 }
  const feature = (coordinates: [number, number], properties: object) => ({ geometry: { coordinates }, properties })
  const house = feature([-70.8, 43.2], { osm_key: "building", osm_value: "house", housenumber: "12", street: "Main Street" })
  const barn = feature([-70.8, 43.2], { osm_key: "building", osm_value: "barn", name: "Barn", extent: [-70.801, 43.201, -70.799, 43.199] })
  const art = feature([-70.8, 43.2], { osm_key: "tourism", osm_value: "artwork", name: "Art" })
  const shop = feature([-70.8001, 43.2], { osm_key: "shop", osm_value: "bakery", name: "Bakery" })
  photonAnswers([art, house, shop, barn])
  expect(await nameAt([], nowhere)).toBe("Barn")
  photonAnswers([art, house, shop])
  expect(await nameAt([], nowhere)).toBe("Bakery")
  photonAnswers([art, house])
  expect(await nameAt([], nowhere)).toBe("12 Main Street")
  vi.stubGlobal("fetch", async () => { throw new TypeError("Load failed") })
  expect(await nameAt([], nowhere)).toBeUndefined()
})
