import { test, expect } from "vitest"
import fc from "fast-check"
import type { Itinerary, Leg } from "../../src/routing/plan.mts"
import type { Run } from "../../src/transit/models/forecast.mts"
import type { Place } from "../../src/places/search.mts"
import { byPattern, othersOf } from "../../src/map/state/ways.mts"

const PLACES: Place[] = [
  { lat: 43.135, lon: -70.93, name: "Your location", isYou: true },
  { lat: 43.136, lon: -70.931, name: "Gables Apartments" },
  { lat: 43.134, lon: -70.933, name: "Kingsbury Hall" },
  { lat: 43.133, lon: -70.928, name: "Madbury Road @ Woodman Road (On Request only)" }
]

/** A way to go: walks between places, and rides on a route from a stop to another */
const way = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant("walk" as const), from: fc.nat(PLACES.length - 1), to: fc.nat(PLACES.length - 1) }),
    fc.record({ kind: fc.constant("ride" as const), route: fc.constantFrom("G", "3", "WE"), from: fc.nat(5), to: fc.nat(5) })
  ),
  { minLength: 1, maxLength: 4 }
)
type Way = typeof way extends fc.Arbitrary<infer T> ? T : never

/**
 * Itineraries ranked best first, each one of a few ways at its own time on a bus of its own, which boards wherever
 * along its trip
 */
const ranked = fc
  .tuple(
    fc.array(way, { minLength: 1, maxLength: 4 }),
    fc.array(fc.record({ way: fc.nat(3), start: fc.integer({ min: 0, max: 7200 }), along: fc.nat(3) }), { minLength: 1, maxLength: 8 })
  )
  .map(([ways, departures]) => departures.map(({ way, start, along }, i) => {
    const shape = ways[way % ways.length]
    const legs = shape.map((leg, j): Leg =>
      leg.kind === "walk"
        ? { kind: "walk", from: PLACES[leg.from], to: PLACES[leg.to], start, end: start + 60, meters: 80, via: "network" }
        : {
            kind: "ride",
            run: { trip: { id: `t${i}-${j}`, route: leg.route, stops: [...Array(along).keys()].map(k => 900 + k).concat(100 + leg.from, 200 + leg.to) }, base: 0 } as unknown as Run,
            fromPosition: along,
            toPosition:   along + 1,
            start,
            end: start + 600
          }
    )
    return { shape, itinerary: { legs, start, end: start + 900 } as Itinerary }
  }))

const sameWay = (a: Way, b: Way) =>
  JSON.stringify(a) === JSON.stringify(b)

test("departures of the same way are grouped, each group in the order of its best, best first, and ways that differ aren't", () =>
  fc.assert(fc.property(ranked, departures => {
    const itineraries = departures.map(({ itinerary }) => itinerary)
    const shapeOf = new Map(departures.map(({ shape, itinerary }) => [itinerary, shape]))
    const groups = byPattern(itineraries)

    // Every itinerary once, each group in the order ranked, and the groups by their best
    expect(groups.flat().sort((a, b) => itineraries.indexOf(a) - itineraries.indexOf(b))).toEqual(itineraries)
    for (const group of groups)
      expect(group.map(it => itineraries.indexOf(it))).toEqual(group.map(it => itineraries.indexOf(it)).sort((a, b) => a - b))
    expect(groups.map(([best]) => itineraries.indexOf(best))).toEqual(groups.map(([best]) => itineraries.indexOf(best)).sort((a, b) => a - b))

    // Together exactly when they go the same way
    for (const a of itineraries)
      for (const b of itineraries)
        expect(groups.some(group => group.includes(a) && group.includes(b))).toBe(sameWay(shapeOf.get(a)!, shapeOf.get(b)!))
  }))
)

test("a way's other departures are all but the one shown, soonest first", () =>
  fc.assert(fc.property(ranked, fc.nat(), (departures, pick) => {
    const [group] = byPattern(departures.map(({ itinerary }) => itinerary))
    const shown = group[pick % group.length]
    const others = othersOf(group, shown)
    expect(others).toHaveLength(group.length - 1)
    expect(others).not.toContain(shown)
    expect(others.map(it => it.start)).toEqual(others.map(it => it.start).sort((a, b) => a - b))
  }))
)

test("a transfer, another stop, or another route is another way", () => {
  const ride = (route: string, from: number, to: number, start: number): Leg =>
    ({ kind: "ride", run: { trip: { id: `${route}${start}`, route, stops: [from, to] }, base: 0 } as unknown as Run, fromPosition: 0, toPosition: 1, start, end: start + 600 })
  const of = (...legs: Leg[]): Itinerary => ({ legs, start: legs[0].start, end: legs.at(-1)!.end })
  const best = of(ride("G", 1, 2, 0))
  const later = of(ride("G", 1, 2, 600))
  const otherStop = of(ride("G", 1, 3, 300))
  const otherRoute = of(ride("3", 1, 2, 300))
  const transfer = of(ride("G", 1, 4, 100), ride("3", 4, 2, 800))
  expect(byPattern([best, otherStop, later, otherRoute, transfer])).toEqual([[best, later], [otherStop], [otherRoute], [transfer]])
})
