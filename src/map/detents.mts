// Where the map's sheet rests, lowered to its header, about half the screen, or tall, and where a drag let go lands
// among them, by where it is and how fast it was going. Pure, for the sheet (ui/sheet.mts) and its tests

export type Detent = "lowered" | "half" | "tall"

/** Lowest first */
export const DETENTS: readonly Detent[] = ["lowered", "half", "tall"]

/** Each detent's height in px: lowered never over half, nor half over tall */
export type Heights = Record<Detent, number>

// px/ms, as fast as a drag is let go for it to be a flick on to the next detent
export const FLICK = 0.25
// ms a finger rests before it's lifted for a drag to end where it is rather than be flicked on
export const STILL_MS = 100

/** How fast a drag is let go: not at all when the finger rested before lifting, however fast it moved before */
export const releaseVelocity = (velocity: number, sinceMoved: number) =>
  sinceMoved > STILL_MS ? 0 : velocity

/**
 * The detent a drag let go lands on. Flicked, up or down, it's the next one on that way from where the sheet is, one
 * at a time, so a flick up from lowered rests at half, and at the end it stays; let go slower, it's the nearest
 */
export const landing = (heights: Heights, extent: number, velocity: number): Detent => {
  if (velocity >= FLICK)
    return DETENTS.find(detent => heights[detent] > extent) ?? "tall"
  if (velocity <= -FLICK)
    return DETENTS.findLast(detent => heights[detent] < extent) ?? "lowered"
  return DETENTS.reduce((a, b) => Math.abs(heights[b] - extent) < Math.abs(heights[a] - extent) ? b : a)
}
