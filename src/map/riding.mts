// Which bus you're on: one you said, or one your phone has been moving with, suggested for you to confirm.
// Each time a bus reports, where you were at that same moment says whether you're on it, which is far surer
// than comparing against where the bus is guessed to be by now. While you're on it and your phone agrees,
// your phone's fixes, about one a second, stand in for the bus's own every 10 to 30

import { r, watch } from "bruh/reactive"
import { distance } from "./feed.mts"
import { compare, fixAt, type Fix } from "./fixes.mts"
import { location } from "./location.mts"
import { STALE_VEHICLE_SECONDS, type Vehicle } from "./umo.mts"
import { vehicles, riding, suggested } from "./state.mts"

// Fixes kept for lining up with buses' reports, which can be this old
const HISTORY_MS = 3 * 60_000
// Reports in a row that make it clear: with the bus, and having gone somewhere together
const AGREEING = 2
const MIN_TOGETHER = 100 // m
// Reports in a row apart from the bus you're on that mean you got off
const DISAGREEING = 2
// A bus you said you're not on isn't suggested again for this long
const DECLINED_MS = 10 * 60_000

let history: Fix[] = []
watch(() => {
  const fix = location.value
  if (!fix)
    return
  history = [...history.filter(old => old.at >= fix.at - HISTORY_MS && old.at < fix.at), fix]
})

/** Whether your phone and the bus you're on agreed when it last reported */
const isInStep = r(false)

/** Each bus's run of reports with you or apart from you, and where you were when it started agreeing */
const streaks = new Map<string, { with: number, apart: number, since?: Fix, gpsTime: number }>()
const declined = new Map<string, number>()

watch([vehicles], () => {
  for (const vehicle of vehicles.value) {
    const streak = streaks.get(vehicle.id) ?? { with: 0, apart: 0, gpsTime: 0 }
    streaks.set(vehicle.id, streak)
    if (vehicle.gpsTime <= streak.gpsTime || vehicle.secsSinceReport >= STALE_VEHICLE_SECONDS)
      continue
    // A report newer than your latest fix waits for one to catch up
    if ((history.at(-1)?.at ?? -Infinity) < vehicle.gpsTime)
      continue
    streak.gpsTime = vehicle.gpsTime
    const you = fixAt(history, vehicle.gpsTime)
    const verdict = you && compare(vehicle, you)
    if (verdict === "with") {
      streak.with++
      streak.apart = 0
      streak.since ??= you
    }
    else if (verdict === "apart") {
      streak.with = 0
      streak.apart++
      streak.since = undefined
    }

    if (vehicle.id === riding.peek()) {
      if (verdict)
        isInStep.value = verdict === "with"
      if (streak.apart >= DISAGREEING)
        riding.value = undefined
    }
  }

  if (riding.peek())
    return
  const now = Date.now()
  const [best] = [...streaks]
    .filter(([id, { with: agreeing, since }]) =>
      agreeing >= AGREEING &&
      since && distance(since, history.at(-1)!) >= MIN_TOGETHER &&
      now - (declined.get(id) ?? -Infinity) > DECLINED_MS
    )
    .sort(([, a], [, b]) => b.with - a.with)
  suggested.value = best?.[0]
})

/** Says you're on a bus, or with undefined that you got off */
export const ride = (id: string | undefined) => {
  // A bus you've just got off is still beside you, so it isn't suggested straight back
  const was = riding.peek()
  if (was && was !== id)
    declined.set(was, Date.now())
  // A suggestion is already in step; a bus you picked waits for its next report to agree
  isInStep.value = id !== undefined && id === suggested.peek()
  suggested.value = undefined
  riding.value = id
}

export const decline = (id: string) => {
  declined.set(id, Date.now())
  if (suggested.peek() === id)
    suggested.value = undefined
}

/** The bus as your phone has it: where you are, how fast you're going, and which way */
const asBus = (vehicle: Vehicle, fix: Fix): Vehicle => ({
  ...vehicle,
  lat: fix.lat,
  lon: fix.lon,
  heading: fix.heading ?? vehicle.heading,
  kph: fix.speed === undefined ? vehicle.kph : fix.speed * 3.6,
  gpsTime: fix.at,
  secsSinceReport: Math.max(0, (Date.now() - fix.at) / 1000)
})

/**
 * Every bus, with the one you're on where your phone says it is, when that's newer than its own report.
 * A bus that's stopped reporting can't keep agreeing, so it isn't carried around on your phone's word alone
 */
export const fusedVehicles = r(() => {
  const id = riding.value
  const fix = location.value
  if (!id || !fix || !isInStep.value)
    return vehicles.value
  return vehicles.value.map(vehicle =>
    vehicle.id === id && fix.at > vehicle.gpsTime && vehicle.secsSinceReport < STALE_VEHICLE_SECONDS
      ? asBus(vehicle, fix)
      : vehicle
  )
})

// The screen stays on while you're riding, to watch for your stop
let wakeLock: Promise<WakeLockSentinel | undefined> | undefined
const holdScreen = () => {
  if (riding.peek() && !wakeLock && document.visibilityState === "visible")
    wakeLock = navigator.wakeLock?.request("screen").catch(() => undefined)
}
watch([riding], () => {
  if (riding.value)
    holdScreen()
  else {
    wakeLock?.then(lock => lock?.release())
    wakeLock = undefined
  }
})
// The lock is let go whenever the page is hidden, so it's taken again on coming back
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden")
    wakeLock = undefined
  else
    holdScreen()
})
