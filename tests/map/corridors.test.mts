import { test, expect } from "vitest"
import fc from "fast-check"
import { laneSlots, layLanes as lay, measureCorridors, type LaneSlots, type Strand } from "../../src/map/corridors.mts"
import { segmentMeters, type Coordinates } from "../../src/map/geometry.mts"

// Every route shown
const layLanes = (strands: Strand[], order: string[]) =>
  laneSlots(measureCorridors(strands), new Set(order), order)

const CENTER = { lat: 43.135, lon: -70.93 }

// A street heading some way out of town, 600 m long
const street = (bearing: number): Coordinates[] =>
  Array.from({ length: 31 }, (_, i) => {
    const radians = bearing * Math.PI / 180
    return [CENTER.lon + Math.sin(radians) * i * 20 / 81_150, CENTER.lat + Math.cos(radians) * i * 20 / 110_540]
  })

const slots = (lanes: LaneSlots[], route: string) =>
  new Set(lanes.filter(lane => lane.route === route).flatMap(lane => lane.slots))

const bearings = fc.integer({ min: 0, max: 359 })

test("a route alone on its street stays on it", () =>
  fc.assert(fc.property(bearings, bearing => {
    expect(slots(layLanes([{ route: "a", coordinates: street(bearing) }], ["a"]), "a")).toEqual(new Set([0]))
  }))
)

test("routes sharing a street one way sit side by side, in order", () =>
  fc.assert(fc.property(bearings, fc.integer({ min: 2, max: 5 }), (bearing, count) => {
    const routes = Array.from({ length: count }, (_, i) => `r${i}`)
    const lanes = layLanes(routes.toReversed().map(route => ({ route, coordinates: street(bearing) })), routes)
    // In order across the street, whichever way it runs
    const sign = [...slots(lanes, routes[0])][0] < 0 ? 1 : -1
    routes.forEach((route, i) =>
      expect(slots(lanes, route)).toEqual(new Set([sign * (i - (count - 1) / 2)]))
    )
  }))
)

test("routes along a street in opposite directions still take different lanes", () =>
  fc.assert(fc.property(bearings, bearing => {
    const lanes = layLanes([
      { route: "a", coordinates: street(bearing) },
      { route: "b", coordinates: street(bearing).toReversed() }
    ], ["a", "b"])
    // Lanes are offset to the right of their own direction, so opposite strands on opposite sides have equal slots
    expect([...slots(lanes, "a"), ...slots(lanes, "b")].map(Math.abs)).toEqual([0.5, 0.5])
    expect(slots(lanes, "a")).toEqual(slots(lanes, "b"))
  }))
)

test("a route going both ways along a street keeps one lane", () =>
  fc.assert(fc.property(bearings, bearing => {
    const lanes = layLanes([
      { route: "a", coordinates: street(bearing) },
      { route: "a", coordinates: street(bearing).toReversed() }
    ], ["a"])
    expect(slots(lanes, "a")).toEqual(new Set([0]))
  }))
)

test("lanes run each strand end to end, drawn a lane's meters across per slot", () =>
  fc.assert(fc.property(bearings, bearings, fc.double({ min: 1, max: 30, noNaN: true }), (a, b, meters) => {
    const strands = [{ route: "a", coordinates: street(a) }, { route: "b", coordinates: street(b) }]
    const lanes = layLanes(strands, ["a", "b"])
    for (const { route, coordinates } of strands) {
      const lane = lanes.find(lane => lane.route === route)!
      expect(lane.points[0]).toEqual(coordinates[0])
      expect(lane.points.at(-1)).toEqual(coordinates.at(-1))
      // Where it starts, its line sits slot × meters off the street
      const [drawn] = lay([lane], meters)
      expect(segmentMeters(drawn.coordinates[0], lane.points[0])).toBeCloseTo(Math.abs(lane.slots[0]) * meters, 3)
    }
  }))
)

test("hiding a route closes up the lanes beside it", () =>
  fc.assert(fc.property(bearings, bearing => {
    const strands = ["a", "b", "c"].map(route => ({ route, coordinates: street(bearing) }))
    const lanes = laneSlots(measureCorridors(strands), new Set(["a", "c"]), ["a", "b", "c"])
    expect(lanes.some(lane => lane.route === "b")).toBe(false)
    expect([...slots(lanes, "a"), ...slots(lanes, "c")].map(Math.abs)).toEqual([0.5, 0.5])
  }))
)

test("a route joining another slides over into its lane rather than jumping", () =>
  fc.assert(fc.property(bearings, fc.integer({ min: 5, max: 25 }), (bearing, joins) => {
    // b runs the whole street, and a only from partway along it
    const lanes = layLanes([
      { route: "a", coordinates: street(bearing).slice(joins) },
      { route: "b", coordinates: street(bearing) }
    ], ["a", "b"])
    for (const { points, slots } of lanes)
      // Half a lane over, eased over 30 m, which is at most 1.5 times as steep as sliding evenly
      slots.slice(1).forEach((slot, i) =>
        expect(Math.abs(slot - slots[i])).toBeLessThanOrEqual(1.5 * 0.5 / 30 * segmentMeters(points[i], points[i + 1]) + 1e-9)
      )
  }))
)
