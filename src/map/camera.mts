// Keeping the camera clear of the panel, and the screen's scale

/** Meters a screen pixel spans at a latitude and zoom, for maplibre's 512 px tiles */
export const metersPerPixel = (lat: number, zoom: number) =>
  40_075_016.686 * Math.cos(lat * Math.PI / 180) / 512 / 2 ** zoom

export type Rect = { top: number, bottom: number, left: number, right: number, width: number, height: number }

export type Padding = { top: number, bottom: number, left: number, right: number }

/** Pads the side of the map the panel covers least of, wherever the CSS put it */
export const coveredPadding = (area: Rect, panel: Rect, margin = 48): Padding => {
  const padding = { top: margin, bottom: margin, left: margin, right: margin }
  if (
    panel.right <= area.left || panel.left >= area.right ||
    panel.bottom <= area.top || panel.top >= area.bottom
  )
    return padding

  const covered = {
    left:   (panel.right - area.left) / area.width,
    right:  (area.right - panel.left) / area.width,
    top:    (panel.bottom - area.top) / area.height,
    bottom: (area.bottom - panel.top) / area.height
  }
  const side = (Object.keys(covered) as (keyof typeof covered)[])
    .reduce((a, b) => covered[a] <= covered[b] ? a : b)
  padding[side] += covered[side] * (side === "left" || side === "right" ? area.width : area.height)
  return padding
}
