import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { readFileSync } from "node:fs"
import { getJson, usable } from "../../src/shared/json.mts"
import { FeedData } from "../../src/transit/feed.mts"
import { Model } from "../../src/transit/models/model.mts"
import { WalkData } from "../../src/routing/graph.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { TilesManifest } from "../../src/map/basemap/tiles.mts"
import { StyleManifest } from "../../src/map/basemap/style.mts"
import { Usual } from "../../src/laundry/model.mts"
import { MenusIndex } from "../../src/dining/menus.mts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const ADDRESS = "https://example.com/data.json"
const Fix = v.object({ id: v.string(), at: v.number() })

/** Values that sometimes fit Fix, sometimes nearly do, and sometimes are anything at all */
const value = fc.oneof(
  fc.record({ id: fc.string(), at: fc.integer() }),
  fc.record({ id: fc.oneof(fc.string(), fc.integer(), fc.constant(null)), at: fc.oneof(fc.integer(), fc.string()) }, { requiredKeys: [] }),
  fc.jsonValue()
)

test("getJson gives what fits its schema, as the schema makes it, and refuses anything else, saying from where and what's wrong", () =>
  fc.assert(fc.asyncProperty(value, async body => {
    vi.stubGlobal("fetch", async () => Response.json(body))
    const fits = v.safeParse(Fix, body)
    const got = getJson(ADDRESS, { schema: Fix })
    if (fits.success)
      await expect(got).resolves.toEqual(fits.output)
    else
      await expect(got).rejects.toThrow(new RegExp(`^Unexpected JSON from ${ADDRESS}: \\S`))
  }))
)

test("an array of the usable keeps exactly the items that fit, in order, and refuses anything but an array", () =>
  fc.assert(fc.property(fc.oneof(fc.array(value), value), body => {
    const parsed = v.safeParse(usable(Fix), body)
    expect(parsed.success).toBe(Array.isArray(body))
    if (Array.isArray(body))
      expect(parsed.output).toEqual(body.filter(item => v.is(Fix, item)).map(item => v.parse(Fix, item)))
  }))
)

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/data/src/${path}.json`, import.meta.url), "utf8"))

test("every data file the pages load, as the fixtures have them, fits its schema", () => {
  const schemas: [string, v.GenericSchema][] = [
    ["map/gtfs", FeedData], ["map/model", Model], ["map/walk", WalkData], ["map/gazetteer", Gazetteer],
    ["map/tiles", TilesManifest], ["map/style", StyleManifest], ["laundry/usual", Usual], ["dining/menus", MenusIndex]
  ]
  for (const [path, schema] of schemas)
    expect(v.safeParse(schema, fixture(path)).issues, path).toBeUndefined()
})
