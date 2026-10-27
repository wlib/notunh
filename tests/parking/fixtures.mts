// The parking sources as last fetched (tests/fixtures/parking/, by node scripts/map/parking.mts --refresh), read as
// the night's check reads them, and the areas they make

import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { AREAS } from "../../src/parking/areas.mts"
import { type Sources, OsmParkingList, ParkMobileList, checked, pdfLines, zoneTable } from "../../src/parking/sources.mts"

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/parking/${name}`, import.meta.url))

export const cachedSources = async (): Promise<Sources> => ({
  table:      zoneTable(await pdfLines(new Uint8Array(await fixture("zones.pdf")))),
  parkMobile: v.parse(ParkMobileList, JSON.parse(`${await fixture("parkmobile.json")}`)).zones,
  osm:        v.parse(OsmParkingList, JSON.parse(`${await fixture("osm.json")}`)).elements
})

export const areas = checked(AREAS, await cachedSources()).areas
