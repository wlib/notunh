// The bitmaps the map draws with: each route's bus and chevrons in its color, the laundry and dining buildings, and
// the points of interest Liberty's sprite has no icon for

import type { Building } from "../../places/buildings.mts"
import type { DRAWN_ICONS } from "../basemap/style.mts"

// Laundry and dining buildings, muted to sit quietly beneath the buses
export const QUIET: Record<Building["kind"], string> = { laundry: "#71839b", dining: "#a1825c" }

// Bitmaps drawn at the screen's own density, and at least twice their size, so they're sharp wherever they're shown
export const DENSITY = Math.max(2, Math.ceil(devicePixelRatio))
const icon = (size: number, draw: (context: OffscreenCanvasRenderingContext2D) => void) => {
  const canvas = new OffscreenCanvas(size * DENSITY, size * DENSITY)
  const context = canvas.getContext("2d")!
  context.scale(DENSITY, DENSITY)
  draw(context)
  return {
    width:  size * DENSITY,
    height: size * DENSITY,
    data: new Uint8Array(context.getImageData(0, 0, size * DENSITY, size * DENSITY).data.buffer)
  }
}

// A circle drawn to a point toward the bearing (north, before rotation), its sides tangent to the circle
export const busIcon = (color: string) =>
  icon(40, context => {
    const [x, y, radius, tip] = [20, 22, 12, 3]
    // The angle either side of straight up where a line from the tip just touches the circle
    const touch = Math.acos(radius / (y - tip))
    context.beginPath()
    context.moveTo(x, tip)
    context.arc(x, y, radius, -Math.PI / 2 + touch, -Math.PI / 2 - touch + 2 * Math.PI)
    context.closePath()
    context.lineJoin = "round"
    context.fillStyle = color
    context.strokeStyle = "white"
    context.lineWidth = 2.5
    context.shadowColor = "rgb(0 0 0 / 0.35)"
    context.shadowBlur = 4
    context.fill()
    context.shadowBlur = 0
    context.stroke()
  })

// Pointing along the line (east, before maplibre aligns it): a pale tint of the line, edged in white
export const chevronIcon = (color: string) =>
  icon(12, context => {
    context.beginPath()
    context.moveTo(3.5, 2)
    context.lineTo(7.5, 6)
    context.lineTo(3.5, 10)
    context.lineCap = "round"
    context.lineJoin = "round"
    context.strokeStyle = "white"
    context.lineWidth = 4
    context.stroke()
    context.strokeStyle = color
    context.lineWidth = 2
    context.stroke()
    // White over it, part way, tints it
    context.globalAlpha = 0.45
    context.strokeStyle = "white"
    context.stroke()
  })

// Glyphs on a 24 unit grid, after Tabler's wash machine, tools kitchen 2, and recycle, pared down to read at a dozen
// pixels
const GLYPHS: Record<Building["kind"] | typeof DRAWN_ICONS[number], string> = {
  laundry:         "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z M16 14a4 4 0 1 1 -8 0a4 4 0 1 1 8 0 M8.5 6.5h.01 M11.5 6.5h.01",
  dining:          "M19 3v12h-5c-.02 -3.68 .18 -7.4 5 -12z M19 15v6 M8 3v18 M5 3v3a3 3 0 0 0 6 0v-3",
  bicycle_parking: "M9.5 15.5a3.5 3.5 0 1 1 -7 0a3.5 3.5 0 1 1 7 0 M21.5 15.5a3.5 3.5 0 1 1 -7 0a3.5 3.5 0 1 1 7 0 M6 15.5l4 -7h6.5l1.5 7 M6 15.5h6l4.5 -7 M10 8.5l2 7 M8.5 6.5h3 M16.5 8.5l-.75 -2.5h2",
  atm:             "M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z M3 10h18 M7 15h3",
  recycling:       "M12 17l-2 2l2 2 M10 19h9a2 2 0 0 0 1.75 -2.75l-.55 -1 M8.536 11l-.732 -2.732l-2.732 .732 M7.804 8.268l-4.5 7.794a2 2 0 0 0 1.506 2.89l1.141 .024 M15.464 11l2.732 .732l.732 -2.732 M18.196 11.732l-4.5 -7.794a2 2 0 0 0 -3.256 -.14l-.591 .976"
}

type Disc = {
  ring:      string,
  disc:      string,
  ink:       string,
  ringWidth: number,
  // The glyph's size as a part of its 24 unit grid, and its strokes' width in those units
  scale:     number,
  weight:    number,
  shadow?:   boolean
}

/** A glyph in a disc, inside a ring of another color, and maybe a shadow */
const discIcon = (size: number, glyph: keyof typeof GLYPHS, { ring, disc, ink, ringWidth, scale, weight, shadow = false }: Disc) =>
  icon(size, context => {
    const middle = size / 2
    context.beginPath()
    context.arc(middle, middle, middle - 1, 0, 2 * Math.PI)
    context.fillStyle = ring
    if (shadow) {
      context.shadowColor = "rgb(0 0 0 / 0.2)"
      context.shadowBlur = 1.5
    }
    context.fill()
    context.shadowColor = "transparent"
    context.beginPath()
    context.arc(middle, middle, middle - 1 - ringWidth, 0, 2 * Math.PI)
    context.fillStyle = disc
    context.fill()
    context.translate(middle, middle)
    context.scale(scale, scale)
    context.translate(-12, -12)
    context.strokeStyle = ink
    context.lineWidth = weight
    context.lineCap = "round"
    context.lineJoin = "round"
    context.stroke(new Path2D(GLYPHS[glyph]))
  })

// A small muted disc in a white ring, with its glyph in white: a washing machine for laundry, a fork and knife
// for dining
export const buildingIcon = (kind: Building["kind"]) =>
  discIcon(20, kind, { ring: "white", disc: QUIET[kind], ink: "white", ringWidth: 1.25, scale: 0.45, weight: 2.25, shadow: true })

// As Liberty's sprite draws points of interest, a colored glyph in a white disc ringed in grey, but for bicycle
// parking, which is white on parking's blue
const POI_ICON = { ring: "#bbb", disc: "white", ringWidth: 1, scale: 0.55, weight: 2.25 }
export const poiIcon = (name: typeof DRAWN_ICONS[number]) =>
  discIcon(21, name, {
    bicycle_parking: { ...POI_ICON, ring: "white", disc: "#4898ff", ink: "white" },
    atm:             { ...POI_ICON, ink: "#5d60be" },
    recycling:       { ...POI_ICON, ink: "#76a723" }
  }[name])
