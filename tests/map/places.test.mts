import { test, expect } from "vitest"
import fc from "fast-check"
import { BUILDINGS, buildingAt } from "../../src/map/places.mts"
import { ROOMS } from "../../src/laundry/rooms.mts"
import type { MenusIndex } from "../../src/dining/menus.mts"
import { slug } from "../../src/shared/slug.mts"
import menus from "../../src/dining/menus.json"

const { halls }: Pick<MenusIndex, "halls"> = menus

// Every id a link can lead to a building by, which for a building with one room may be the room's as well
const linksTo = BUILDINGS.map(building => [...new Set([building.id, ...building.rooms?.map(room => `${building.kind}/${room}`) ?? []])])

const buildingsAt = (id: string) =>
  BUILDINGS.filter((_, i) => linksTo[i].includes(id))

test("every laundry room and dining hall is in exactly one building of its kind", () => {
  for (const room of ROOMS)
    expect(buildingsAt(`laundry/${slug(room.name)}`)).toEqual([expect.objectContaining({ kind: "laundry" })])
  for (const hall of halls)
    expect(buildingsAt(`dining/${slug(hall.name)}`)).toEqual([expect.objectContaining({ kind: "dining", name: hall.name })])
})

test("rooms share a building only where they're in the same hall", () => {
  const at = (slug: string) => buildingAt(`laundry/${slug}`)?.name
  expect(at("stoke-hall-g05")).toBe("Stoke Hall")
  expect(at("stoke-hall-g72")).toBe("Stoke Hall")
  expect(at("hetzel-1st-floor")).toBe("Hetzel Hall")
  expect(at("hetzel-3rd-floor")).toBe("Hetzel Hall")
  const gables = ["gables-a", "gables-b", "gables-c", "gables-north", "gables-south"].map(slug => buildingAt(`laundry/${slug}`))
  expect(new Set(gables).size).toBe(5)
  expect(gables).not.toContain(undefined)
})

test("buildings are on campus, with ids of their kind, and no link leads to two", () => {
  expect(new Set(linksTo.flat()).size).toBe(linksTo.flat().length)
  for (const building of BUILDINGS) {
    expect(building.id).toMatch(new RegExp(`^${building.kind}/[a-z0-9]+(-[a-z0-9]+)*$`))
    expect(building.lat).toBeGreaterThan(43.125)
    expect(building.lat).toBeLessThan(43.15)
    expect(building.lon).toBeGreaterThan(-70.96)
    expect(building.lon).toBeLessThan(-70.915)
    // Laundry buildings list their rooms, and dining halls none
    expect(building.rooms === undefined).toBe(building.kind === "dining")
    expect(building.rooms).not.toEqual([])
    expect(buildingsAt(building.id)).toEqual([building])
  }
  // Rooms have the slugs laundry gives them, and only rooms there are have a building
  const rooms = BUILDINGS.flatMap(building => building.rooms ?? [])
  expect(rooms.toSorted()).toEqual(ROOMS.map(room => slug(room.name)).toSorted())
})

test("a link leads to the building it names, or to none", () =>
  fc.assert(fc.property(
    fc.oneof(
      fc.constantFrom(...linksTo.flat()),
      fc.tuple(fc.constantFrom("laundry/", "dining/", ""), fc.string()).map(([kind, rest]) => kind + rest)
    ),
    id => {
      const building = buildingAt(id)
      expect(building === undefined ? [] : [building]).toEqual(buildingsAt(id))
    }
  ))
)
