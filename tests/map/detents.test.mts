import { test, expect } from "vitest"
import fc from "fast-check"
import { DETENTS, EDGE, FLICK, type Heights, STILL_MS, canSwipeBack, landing, owner, placed, releaseVelocity, swipesBack, travelOf } from "../../src/map/detents.mts"

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

const move = fc.record({ dx: fc.integer({ min: -300, max: 300 }), dy: fc.integer({ min: -300, max: 300 }) })

test("a touch's first move gives it to the sheet, but for a pull up at tall with more to show, or a sideways one, which is the page's to swipe back where it may be, else the content's", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), move, (isTall, canScroll, canGoBack, { dx, dy }) => {
    const whose = owner({ isTall, canScroll, canGoBack, dx, dy })
    if (Math.abs(dx) > Math.abs(dy))
      expect(whose).toBe(dx > 0 && canGoBack ? "back" : "content")
    else if (!isTall)
      expect(whose).toBe("sheet")
    else
      expect(whose).toBe(dy < 0 && canScroll ? "content" : "sheet")
    // A vertical move is never a swipe back, and a move left never is
    if (dy !== 0 && Math.abs(dy) >= Math.abs(dx) || dx < 0)
      expect(whose).not.toBe("back")
  }))
  // Below tall the sheet moves whichever way, however far the content's scrolled; at tall, pulled down, so does it
  expect(owner({ isTall: false, canScroll: true, canGoBack: true, dx: 0, dy: -40 })).toBe("sheet")
  expect(owner({ isTall: true, canScroll: true, canGoBack: true, dx: 0, dy: 40 })).toBe("sheet")
  expect(owner({ isTall: true, canScroll: true, canGoBack: true, dx: 0, dy: -40 })).toBe("content")
  expect(owner({ isTall: true, canScroll: false, canGoBack: true, dx: 0, dy: -40 })).toBe("sheet")
  expect(owner({ isTall: true, canScroll: false, canGoBack: true, dx: 40, dy: 10 })).toBe("back")
  expect(owner({ isTall: true, canScroll: false, canGoBack: false, dx: 40, dy: 10 })).toBe("content")
})

test("a touch may swipe back only with a page shown, off the screen's left edge, and off anything that scrolls sideways", () => {
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 0, max: 400 }), fc.boolean(), (hasPage, x, inScroller) => {
    expect(canSwipeBack({ hasPage, x, inScroller })).toBe(hasPage && !inScroller && x >= EDGE)
  }))
  expect(canSwipeBack({ hasPage: true, x: EDGE - 1, inScroller: false })).toBe(false)
  expect(canSwipeBack({ hasPage: true, x: EDGE, inScroller: false })).toBe(true)
})

test("a swipe let go goes back from a third of the way across, or flicked that way from anywhere, and never from a move left", () => {
  fc.assert(fc.property(fc.integer({ min: 200, max: 800 }), fc.integer({ min: -800, max: 800 }), fc.double({ min: -8, max: 8, noNaN: true }), (width, dx, velocity) => {
    const goes = swipesBack(width, dx, velocity)
    expect(goes).toBe(dx > 0 && (dx >= width / 3 || velocity >= FLICK))
    if (dx <= 0)
      expect(goes).toBe(false)
    if (dx >= width / 3)
      expect(goes).toBe(true)
  }))
})

/** A sheet's heights, how far its content can scroll, and where a drag found it: an extent, and a scroll position */
const found = heights.chain(h => fc.record({
  h:         fc.constant(h),
  maxScroll: fc.integer({ min: 0, max: 2000 }),
  extent:    fc.integer({ min: h.lowered, max: h.tall })
})).chain(({ h, maxScroll, extent }) => fc.record({ h: fc.constant(h), maxScroll: fc.constant(maxScroll), extent: fc.constant(extent), scrollTop: fc.integer({ min: 0, max: maxScroll }) }))

test("a drag's travel moves the sheet up to tall and then scrolls the content, each within its bounds, never going back on itself", () => {
  fc.assert(fc.property(found, fc.integer({ min: -3000, max: 3000 }), fc.integer({ min: 0, max: 100 }), ({ h, maxScroll, extent, scrollTop }, by, more) => {
    const { from, base, most } = travelOf(h, extent, scrollTop, maxScroll)
    // Where it was found is where its travel starts
    expect(placed(h, from, base, maxScroll)).toEqual({ extent, scrollTop })
    expect(most).toBeGreaterThanOrEqual(from)
    const a = placed(h, from + by, base, maxScroll)
    const b = placed(h, from + by + more, base, maxScroll)
    for (const p of [a, b]) {
      expect(p.extent).toBeGreaterThanOrEqual(h.lowered)
      expect(p.extent).toBeLessThanOrEqual(h.tall)
      expect(p.scrollTop).toBeGreaterThanOrEqual(0)
      expect(p.scrollTop).toBeLessThanOrEqual(maxScroll)
    }
    // Further travel never lowers the sheet or scrolls the content back
    expect(b.extent).toBeGreaterThanOrEqual(a.extent)
    expect(b.scrollTop).toBeGreaterThanOrEqual(a.scrollTop)
    // Short of tall, the content stays where the drag found it; past the furthest, nothing more moves
    if (from + by <= h.tall)
      expect(a.scrollTop).toBe(base)
    expect(placed(h, most + 1, base, maxScroll)).toEqual(placed(h, most, base, maxScroll))
  }))
})

test("a drag from tall with the content scrolled down takes that back to its top before the sheet comes down", () => {
  fc.assert(fc.property(found.filter(f => f.extent === f.h.tall && f.scrollTop > 0), ({ h, maxScroll, scrollTop }) => {
    const { from, base } = travelOf(h, h.tall, scrollTop, maxScroll)
    expect(placed(h, from - scrollTop, base, maxScroll)).toEqual({ extent: h.tall, scrollTop: 0 })
    expect(placed(h, from - scrollTop - 1, base, maxScroll).extent).toBe(h.tall - 1)
  }))
})
