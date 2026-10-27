// Keeping the camera clear of the panel, following the page shown, and the screen's scale

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

/**
 * What the camera is aimed at: the view of the page shown, by its link, and what of it to show, by a key, or nothing
 * yet, as while its place or its trip is still to come
 */
export type Aim = { view: string, target?: string }

/**
 * Where the camera's aim goes next, and whether it moves: only for the page shown, once when it opens with something
 * to show, and again only when what it shows is another thing. Something gone for a moment, as a trip being planned
 * again, is still what it was, so its coming back doesn't move the map
 */
export const aimed = (held: Aim | undefined, next: Aim): { held: Aim, move: boolean } => {
  if (held?.view !== next.view)
    return { held: next, move: next.target !== undefined }
  if (next.target === undefined || next.target === held.target)
    return { held, move: false }
  return { held: next, move: true }
}
