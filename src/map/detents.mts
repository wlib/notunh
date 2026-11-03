// Where the map's sheet rests, lowered to its header, about half the screen, or tall, and where a drag let go lands
// among them, by where it is and how fast it was going; and whose a touch is, the sheet's, the content's, or a page's
// to swipe back. Pure, for the sheet (ui/sheet.mts) and its tests

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

/** Whose a touch is: the sheet's to drag, the content's to scroll, or the page's to swipe back */
export type Owner = "sheet" | "content" | "back"

/**
 * Whose a touch on the content is, which its first move decides for good. Below tall, the sheet's, either way: it's
 * what moves until it's tall, and only then does the content scroll. At tall, pulled up with more to show, the
 * content's, scrolling as it does anywhere; pulled down, the sheet's, which takes the content back to its top and
 * then comes down, all in the one pull. Sideways to the right, where the touch may go back (canSwipeBack), is the
 * page's, to swipe back; any other sideways move is the content's, for whatever in it scrolls that way
 */
export const owner = ({ isTall, canScroll, canGoBack, dx, dy }: { isTall: boolean, canScroll: boolean, canGoBack: boolean, dx: number, dy: number }): Owner =>
  Math.abs(dx) > Math.abs(dy)   ? dx > 0 && canGoBack ? "back" : "content" :
  isTall && dy < 0 && canScroll ? "content" :
                                  "sheet"

// px of the screen's left edge that Safari's own swipe back starts from, left to it
export const EDGE = 20

/**
 * Whether a touch may swipe the page back: there's a page to go back from, it didn't start where the browser's own
 * swipe back does, and it's not on something that scrolls sideways itself, like a row of chips
 */
export const canSwipeBack = ({ hasPage, x, inScroller }: { hasPage: boolean, x: number, inScroller: boolean }) =>
  hasPage && !inScroller && x >= EDGE

/** Whether a swipe back let go goes back: far enough across the page, or flicked that way; else it springs back */
export const swipesBack = (width: number, dx: number, velocity: number) =>
  dx > 0 && (dx >= width / 3 || velocity >= FLICK)

/** Where a drag has put the sheet and its content, in px: how much of the sheet shows, and how far down the content is */
export type Placed = { extent: number, scrollTop: number }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * Where a drag's travel, px up from nothing, has the sheet and its content, as one: the sheet, up to tall, and on past
 * that the content scrolled from where it was, so a pull up from half runs on into the list, and a pull down from in
 * the list runs back to its top and on into lowering the sheet. A drag starting below tall keeps the content where it
 * was until the sheet is tall; one starting at tall has its scroll as travel already made
 */
export const placed = (heights: Pick<Heights, "lowered" | "tall">, travel: number, base: number, maxScroll: number): Placed => ({
  extent:    clamp(travel, heights.lowered, heights.tall),
  scrollTop: clamp(base + Math.max(0, travel - heights.tall), 0, maxScroll)
})

/** Where a drag's travel starts, and its furthest, for a sheet showing this much with its content scrolled this far */
export const travelOf = (heights: Pick<Heights, "lowered" | "tall">, extent: number, scrollTop: number, maxScroll: number) => {
  const isTall = extent >= heights.tall
  const base = isTall ? 0 : scrollTop
  return { from: isTall ? heights.tall + scrollTop : extent, base, most: heights.tall + Math.max(0, maxScroll - base) }
}
