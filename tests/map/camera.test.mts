import { test, expect } from "vitest"
import fc from "fast-check"
import { type Aim, aimed, coveredPadding } from "../../src/map/render/camera.mts"

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height })

const viewport = fc.record({ width: fc.integer({ min: 300, max: 2000 }), height: fc.integer({ min: 400, max: 1400 }) })

test("a bottom sheet pads the bottom by what it covers", () =>
  fc.assert(fc.property(viewport, fc.double({ min: 0.1, max: 0.6, noNaN: true }), ({ width, height }, share) => {
    const padding = coveredPadding(rect(0, 0, width, height), rect(0, height * (1 - share), width, height * share), 48)
    expect(padding).toEqual({ top: 48, left: 48, right: 48, bottom: expect.closeTo(48 + height * share, 6) })
  }))
)

test("a side panel pads its side, and a panel off the map pads nothing extra", () =>
  fc.assert(fc.property(viewport, fc.integer({ min: 280, max: 420 }), fc.integer({ min: 0, max: 24 }), ({ width, height }, panelWidth, gap) => {
    fc.pre(panelWidth + gap < width / 2)
    const area = rect(0, 0, width, height)
    expect(coveredPadding(area, rect(gap, gap, panelWidth, height / 2), 48))
      .toEqual({ top: 48, bottom: 48, right: 48, left: expect.closeTo(48 + gap + panelWidth, 6) })
    expect(coveredPadding(area, rect(width, 0, panelWidth, height), 48))
      .toEqual({ top: 48, bottom: 48, left: 48, right: 48 })
  }))
)

test("the camera moves once as a page opens with somewhere to show, again only for somewhere else, and never as what it shows blinks out and back", () =>
  fc.assert(fc.property(fc.array(fc.record({ view: fc.constantFrom("/map/?place=A", "/map/?event=e", "/map/?directions", "/map/"), target: fc.option(fc.constantFrom("x", "y", "z"), { nil: undefined }) }), { maxLength: 40 }), aims => {
    let held: Aim | undefined
    /** The page shown, and the last place or trip of it the camera went to */
    let view: string | undefined
    let shown: string | undefined
    for (const next of aims) {
      const step = aimed(held, next)
      held = step.held
      if (next.view !== view) {
        view = next.view
        shown = undefined
      }
      const shouldMove = next.target !== undefined && next.target !== shown
      expect(step.move).toBe(shouldMove)
      if (shouldMove)
        shown = next.target
      expect(held.view).toBe(next.view)
    }
  }))
)

test("a page shown again after another moves the camera back to it, and the same aim twice moves it once", () => {
  const first = aimed(undefined, { view: "/map/?place=A", target: "a" })
  expect(first.move).toBe(true)
  expect(aimed(first.held, { view: "/map/?place=A", target: "a" }).move).toBe(false)
  const away = aimed(first.held, { view: "/map/?event=e", target: "e" })
  expect(aimed(away.held, { view: "/map/?place=A", target: "a" }).move).toBe(true)
})
