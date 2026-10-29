// The ways to reserve or borrow something at a place (src/places/services.mts): each at a place the map knows, and few

import { test, expect } from "vitest"
import { readFile } from "node:fs/promises"
import { SERVICES, servicesAt } from "../../src/places/services.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"

const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))

test("each way to reserve or borrow is at a place the map knows, by https, and a place has at most one or two", () => {
  const names = new Set(gazetteer.places.map(place => place.name))
  for (const service of SERVICES) {
    expect(names.has(service.place)).toBe(true)
    expect(service.url).toMatch(/^https:\/\//)
    expect(servicesAt(service.place).length).toBeLessThanOrEqual(2)
  }
  expect(servicesAt("Hamel Rec Center").map(({ url }) => url)).toEqual(["https://crec.unh.edu/booking"])
  expect(servicesAt("Thompson Hall")).toEqual([])
})
