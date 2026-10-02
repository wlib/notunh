import { test, expect } from "vitest"
import fc from "fast-check"
import { distance } from "../../src/map/feed.mts"
import { project } from "../../src/map/geometry.mts"
import { compare, fixAt, isWorthTaking, reckon, type Fix } from "../../src/map/fixes.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

const fixes = fc.record({
  lat:      fc.double({ min: CENTER.lat - 0.02, max: CENTER.lat + 0.02, noNaN: true }),
  lon:      fc.double({ min: CENTER.lon - 0.02, max: CENTER.lon + 0.02, noNaN: true }),
  accuracy: fc.double({ min: 3, max: 2000, noNaN: true }),
  speed:    fc.option(fc.double({ min: 0, max: 30, noNaN: true }), { nil: undefined }),
  heading:  fc.option(fc.double({ min: 0, max: 359.9, noNaN: true }), { nil: undefined }),
  at:       fc.integer({ min: 1e12, max: 2e12 })
})

test("isWorthTaking keeps a good fix, and a poor one unless a good one came within 10 s", () => {
  fc.assert(fc.property(fixes, fixes, fc.integer({ min: 0, max: 60_000 }), (last, next, gap) => {
    const later = { ...next, at: last.at + gap }
    const isPoor = (fix: Fix) => fix.accuracy > 50
    expect(isWorthTaking(undefined, later)).toBe(true)
    expect(isWorthTaking(last, later)).toBe(!isPoor(later) || isPoor(last) || gap > 10_000)
  }))
})

test("reckon carries you on at your speed for up to 3 s, and leaves you put when you're still", () => {
  fc.assert(fc.property(fixes, fc.integer({ min: 0, max: 20_000 }), (fix, elapsed) => {
    const [lon, lat] = reckon(fix, fix.at + elapsed)
    const moved = distance(fix, { lat, lon })
    const isMoving = fix.speed !== undefined && fix.heading !== undefined && fix.speed >= 1
    const expected = isMoving ? fix.speed! * Math.min(3, elapsed / 1000) : 0
    // Within the flat-earth approximation that projecting makes
    expect(Math.abs(moved - expected)).toBeLessThanOrEqual(expected * 0.01 + 0.01)
  }))
})

test("fixAt is between the fixes either side, and unknown outside them or across a gap between them", () => {
  fc.assert(fc.property(fixes, fc.integer({ min: 1, max: 20_000 }), fc.double({ min: 0, max: 1, noNaN: true }), (a, gap, t) => {
    const b = { ...a, lat: a.lat + 0.001, at: a.at + gap }
    const at = a.at + Math.round(t * gap)
    const found = fixAt([a, b], at)
    // Across a gap, only a fix taken at that very time says where you were
    if (gap > 10_000) {
      expect(found).toEqual(at === a.at ? a : at === b.at ? b : undefined)
      return
    }
    expect(found!.lat).toBeGreaterThanOrEqual(a.lat)
    expect(found!.lat).toBeLessThanOrEqual(b.lat)
    expect(found!.at).toBe(at)
    expect(fixAt([a, b], a.at - 1)).toBeUndefined()
    expect(fixAt([a, b], b.at + 1)).toBeUndefined()
  }))
})

const moving = (heading: number) => ({ ...CENTER, heading, kph: 30 })

test("compare puts you with a bus beside you going your way, and apart from one far off", () => {
  fc.assert(fc.property(
    fc.double({ min: 0, max: 359.9, noNaN: true }),
    fc.double({ min: 0, max: 359.9, noNaN: true }),
    fc.double({ min: 0, max: 400, noNaN: true }),
    (heading, bearing, meters) => {
      const [lon, lat] = project([CENTER.lon, CENTER.lat], bearing, meters)
      const you: Fix = { lat, lon, accuracy: 10, speed: 8, heading, at: 0 }
      const verdict = compare(moving(heading), you)
      if (meters < 55)
        expect(verdict).toBe("with")
      if (meters > 155)
        expect(verdict).toBe("apart")
      // Going the other way past each other isn't riding
      expect(compare(moving((heading + 180) % 360), you)).not.toBe("with")
    }
  ))
})
