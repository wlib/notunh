import { test, expect } from "vitest"
import fc from "fast-check"
import { DETENTS, FLICK, type Heights, STILL_MS, landing, releaseVelocity } from "../../src/map/detents.mts"

/** Heights in order, lowered under half under tall, as a phone's sheet has them, or with half as tall as tall, as the keyboard leaves it */
const heights: fc.Arbitrary<Heights> = fc.tuple(fc.integer({ min: 40, max: 200 }), fc.integer({ min: 1, max: 600 }), fc.integer({ min: 0, max: 600 }))
  .map(([lowered, toHalf, toTall]) => ({ lowered, half: lowered + toHalf, tall: lowered + toHalf + toTall }))
/** A height the sheet can be dragged to: anywhere from lowered to tall */
const dragged = heights.chain(h => fc.tuple(fc.constant(h), fc.integer({ min: h.lowered, max: h.tall })))
const flick = fc.double({ min: FLICK, max: 8, noNaN: true })
const slow = fc.double({ min: -FLICK, max: FLICK, noNaN: true }).filter(v => Math.abs(v) < FLICK)

test("a flick moves on to the next detent that way, never past one, and from the end stays there", () => {
  fc.assert(fc.property(dragged, flick, fc.boolean(), ([h, extent], speed, isUp) => {
    const landed = landing(h, extent, isUp ? speed : -speed)
    expect(DETENTS).toContain(landed)
    // On that way, or at the end already
    if (isUp)
      expect(h[landed] > extent || landed === "tall").toBe(true)
    else
      expect(h[landed] < extent || landed === "lowered").toBe(true)
    // No detent lies strictly between where it was and where it lands
    const [low, high] = [Math.min(extent, h[landed]), Math.max(extent, h[landed])]
    for (const detent of DETENTS)
      expect(h[detent] > low && h[detent] < high).toBe(false)
  }))
})

test("a flick up from below half rests at half, never tall, while half is short of tall", () => {
  fc.assert(fc.property(heights.filter(h => h.half < h.tall), h => {
    expect(landing(h, h.lowered, 10)).toBe("half")
    expect(landing(h, h.half - 1, 10)).toBe("half")
    expect(landing(h, h.half, 10)).toBe("tall")
    expect(landing(h, h.tall, -10)).toBe("half")
  }))
})

test("let go slowly, the sheet rests at the nearest detent", () => {
  fc.assert(fc.property(dragged, slow, ([h, extent], velocity) => {
    const landed = landing(h, extent, velocity)
    for (const detent of DETENTS)
      expect(Math.abs(h[landed] - extent)).toBeLessThanOrEqual(Math.abs(h[detent] - extent))
  }))
})

test("a finger that rested before lifting isn't flicking, however fast it moved before", () => {
  fc.assert(fc.property(fc.double({ min: -8, max: 8, noNaN: true }), fc.integer({ min: 0, max: 1000 }), (velocity, since) => {
    expect(releaseVelocity(velocity, since)).toBe(since > STILL_MS ? 0 : velocity)
  }))
})
