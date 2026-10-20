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

// The panel's size settles this soon after it changes what it shows
const SETTLE_MS = 1000

/** Shows something with the camera, kept clear of the panel by the padding it's given */
export type Show = (intent: (padding: Padding) => void) => void

/**
 * What the camera should show, kept clear of the panel and reapplied while the panel settles into its new size,
 * then left alone; touching the map lets go of it right away
 */
export const framing = (container: HTMLElement, panel: HTMLElement): Show => {
  let intent: ((padding: Padding) => void) | undefined
  let settled: ReturnType<typeof setTimeout> | undefined
  const frame = () =>
    intent?.(coveredPadding(container.getBoundingClientRect(), panel.getBoundingClientRect()))
  new ResizeObserver(frame).observe(panel)
  for (const type of ["pointerdown", "wheel", "keydown"])
    container.addEventListener(type, () => intent = undefined, { capture: true, passive: true })
  return next => {
    intent = next
    clearTimeout(settled)
    settled = setTimeout(() => intent = undefined, SETTLE_MS)
    // After this flush's DOM updates, so the panel has its new size
    queueMicrotask(frame)
  }
}
