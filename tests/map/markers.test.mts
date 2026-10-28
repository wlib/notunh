// The map's markers for today (src/map/render/layers.mts): one per place with something on, labelled in words by
// what's on there now, else by what's next, and nothing for a place whose events have all ended

import { test, expect, vi } from "vitest"
import fc from "fast-check"
import type { Placed } from "../../src/map/state/today.mts"
import { clockOf } from "../../src/shared/time.mts"

// The icons beside the layers are drawn for the screen's density, which Node hasn't
vi.stubGlobal("devicePixelRatio", 1)
const { eventFeatures } = await import("../../src/map/render/layers.mts")

const NOW = Date.UTC(2026, 9, 7, 16)
const PLACES = ["Kingsbury Hall", "Memorial Union Building", "Bremner Field"].map((name, i) => ({ name, lat: 43.13 + i / 1000, lon: -70.93 }))

const aPlaced: fc.Arbitrary<Placed> = fc.record({
  place: fc.constantFrom(...PLACES),
  start: fc.integer({ min: -6 * 60, max: 10 * 60 }),
  minutes: fc.integer({ min: 15, max: 180 }),
  title: fc.constantFrom("Tennis", "Career Night", "Open mic")
}).map(({ place, start, minutes, title }) => ({
  place,
  event: { id: `${title}:${start}`, title, start: NOW + start * 60_000, end: NOW + (start + minutes) * 60_000, place: place.name, where: "", source: "25live", url: "" }
}))

test("each place with something still on today is one marker, labelled by the first still to end there, filled while it's on", () =>
  fc.assert(fc.property(fc.array(aPlaced, { maxLength: 12 }).map(placed => placed.toSorted((a, b) => a.event.start - b.event.start)), placed => {
    const features = eventFeatures(placed, NOW)
    const ahead = placed.filter(({ event }) => event.end > NOW)
    expect(features.map(feature => feature.properties!.place).toSorted()).toEqual([...new Set(ahead.map(({ place }) => place.name))].toSorted())
    for (const feature of features) {
      const { event } = ahead.find(({ place }) => place.name === feature.properties!.place)!
      expect(feature.properties!.on).toBe(event.start <= NOW)
      expect(feature.properties!.label).toBe(event.start <= NOW ? `${event.title} · till ${clockOf(event.end)}` : `${event.title} · ${clockOf(event.start)}`)
    }
  }))
)
