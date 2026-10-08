// Whether the page is in view and since when, for things that only run while it is or count from then; the one
// clock every page reads; and a fresh start after long enough away that nothing in memory is worth keeping: the
// schedule and menus rebuild nightly, phones have long since let go of the page anyway, and what was on screen an
// hour ago is stale

import { r } from "bruh/reactive"
import { HOUR, localDay } from "../shared/time.mts"
import { distinct } from "./state.mts"

const LONG_AWAY_MS = HOUR
export const TICK_MS = 15_000

const loadedDay = localDay(Date.now())
// A page opened out of view, like in a background tab, has been away since it loaded
let hiddenAt = document.visibilityState === "hidden" ? Date.now() : undefined

/** Whether the page is in view, which polling, GPS, and the wake lock follow */
export const isVisible = r(hiddenAt === undefined)
/** Epoch milliseconds the page was loaded or last brought back into view, or undefined while it's out of view */
export const visibleSince = r(hiddenAt === undefined ? Date.now() : undefined)
/** Epoch milliseconds, every TICK_MS and on coming back, since timers sleep with the page; one clock for every page */
export const now = r(Date.now())
/** Today in Durham, reaching what depends on it only when the day changes */
export const today = distinct(() => localDay(now.value))

setInterval(() => {
  now.value = Date.now()
}, TICK_MS)

const resume = () => {
  if (document.visibilityState !== "visible" || hiddenAt === undefined)
    return
  const at = Date.now()
  const isLongAway = at - hiddenAt >= LONG_AWAY_MS || localDay(at) !== loadedDay
  hiddenAt = undefined
  if (isLongAway)
    return location.reload()
  visibleSince.value = at
  now.value = at
  isVisible.value = true
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt ??= Date.now()
    visibleSince.value = undefined
    isVisible.value = false
  }
  else
    resume()
})
// Back from the back-forward cache, in case the visibility event didn't come with it
addEventListener("pageshow", resume)
