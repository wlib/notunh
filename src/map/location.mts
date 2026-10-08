// Your location, watched with GPS while the map is in view, from when it's first asked for.
// High accuracy is what makes it GPS at all on iOS, rather than Wi-Fi a hundred meters off

import { r, watch } from "bruh/reactive"
import { isWorthTaking, type Fix } from "./fixes.mts"
import { isVisible } from "../shell/lifecycle.mts"

/** The latest fix worth showing */
export const location = r<Fix>()
/** Why the location couldn't be found, in words for the person who asked */
export const locationProblem = r<string>()

const UNSUPPORTED = "This browser can't share your location with this page. Search for a place instead."
const DENIED = "notunh isn't allowed to see your location. Allow it in your browser's settings for this site, or search for a place."
const TOO_LONG = "Finding your location took too long. Try again, or search for a place."

// Long enough for a cold GPS start outdoors
const FIRST_FIX_MS = 15_000

// Browsers only share location with secure pages, so not over plain http on a local network
const isSupported = isSecureContext && "geolocation" in navigator

let isWanted = false
let watchId: number | undefined
/** Those waiting on the next fix */
let waiting: { resolve: (fix: Fix) => void, reject: (problem: string) => void }[] = []

const settle = (outcome: { fix: Fix } | { problem: string }) => {
  const settled = waiting
  waiting = []
  for (const { resolve, reject } of settled)
    "fix" in outcome ? resolve(outcome.fix) : reject(outcome.problem)
}

const take = ({ coords, timestamp }: GeolocationPosition) => {
  // Safari reports an unknown speed or heading as null or as negative, and a heading while still as NaN
  const speed = coords.speed !== null && coords.speed >= 0 ? coords.speed : undefined
  const heading = coords.heading !== null && Number.isFinite(coords.heading) && coords.heading >= 0 ? coords.heading : undefined
  const fix: Fix = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, speed, heading, at: timestamp }
  if (isWorthTaking(location.peek(), fix))
    location.value = fix
  settle({ fix: location.peek()! })
}

// Denied is final; the rest is GPS losing its signal for a moment, as iOS reports indoors, which watching rides
// out, so those waiting on a fix wait out their own timeout instead
const fail = (error: GeolocationPositionError) => {
  if (error.code !== error.PERMISSION_DENIED)
    return
  settle({ problem: DENIED })
  isWanted = false
  pause()
}

const resume = () => {
  if (watchId === undefined && isWanted && isVisible.peek())
    watchId = navigator.geolocation.watchPosition(take, fail, { enableHighAccuracy: true, maximumAge: 0 })
}

const pause = () => {
  if (watchId !== undefined)
    navigator.geolocation.clearWatch(watchId)
  watchId = undefined
}

// GPS is the battery's biggest drain, and a page out of view can't use it anyway
watch([isVisible], () => isVisible.value ? resume() : pause())

/** Starts watching, which shows the location from then on */
export const watchLocation = () => {
  if (!isSupported)
    return
  isWanted = true
  resume()
}

/** A fix from the last few seconds, or the next one */
export const currentLocation = ({ fresh = 10_000 } = {}) =>
  new Promise<Fix>((resolve, reject) => {
    if (!isSupported)
      return reject(UNSUPPORTED)
    const last = location.peek()
    if (last && Date.now() - last.at <= fresh)
      return resolve(last)
    const timeout = setTimeout(() => reject(TOO_LONG), FIRST_FIX_MS)
    waiting.push({
      resolve: fix => { clearTimeout(timeout); resolve(fix) },
      reject: problem => { clearTimeout(timeout); reject(problem) }
    })
    watchLocation()
  })

// Watch from the start if it's already allowed, as asking again would only be noise
navigator.permissions?.query({ name: "geolocation" })
  .then(status => {
    if (status.state === "granted")
      watchLocation()
  })
  .catch(() => {})
