// Whether the page is in view and since when, for things that only run while it is or count from then; the one
// clock every page reads; and a fresh start after long enough away that nothing in memory is worth keeping, as
// phones have long since let go of the page anyway and what was on screen an hour ago is stale, or once there's
// newer code, which only a reload brings in. Neither comes while the page is in the middle of something a reload
// would lose, like a bus ride, and newer code only out of view, so no one sees it. Newer data needs no reload, as
// pages swap it in live (build.mts)

import { r, watch } from "bruh/reactive"
import { HOUR, localDay } from "../shared/time.mts"
import { distinct } from "./state.mts"
import { isNewBuild } from "./build.mts"

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

/** Whether the page is in the middle of something a reload would lose, like riding a bus, which pages set */
export const isBusy = r(false)
/** Whether the page has been away long enough that a fresh start is due, once it's free */
const isStale = r(false)

const resume = () => {
  if (document.visibilityState !== "visible" || hiddenAt === undefined)
    return
  const at = Date.now()
  const isLongAway = at - hiddenAt >= LONG_AWAY_MS || localDay(at) !== loadedDay
  hiddenAt = undefined
  if (isLongAway && !isBusy.peek())
    return location.reload()
  isStale.value ||= isLongAway
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

// Newer code, or a fresh start put off while busy, comes in out of view, as soon as it's due, the page goes out of
// view, and nothing's lost, whichever is last
watch([isNewBuild, isStale, isVisible, isBusy], () => {
  if ((isNewBuild.value || isStale.value) && !isVisible.value && !isBusy.value)
    location.reload()
})
