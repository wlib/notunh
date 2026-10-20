// Which bus you're on: one you said, or one your phone has been moving with, suggested for you to confirm. Each time a
// bus reports, where you were at that same moment says whether you're on it. That's far surer than comparing against
// where the bus is guessed to be by now. While you're on it and your phone agrees, your phone's fixes, about one a
// second, stand in for the bus's own, which come every 10 to 30 seconds

import { r, watch } from "bruh/reactive"
import { type Following, follow } from "../../geo/follow.mts"
import { distance } from "../../geo/projection.mts"
import { BUS_TRACKING, type RouteLine, routeLines } from "../../transit/shapes.mts"
import { compare, fixAt, type Fix } from "../../geo/fixes.mts"
import type { Vehicle } from "../../transit/observations/umo.mts"
import type { Fixed } from "./following.mts"
import type { MapData } from "./data.mts"
import type { createLocation } from "./location.mts"
import type { createLive } from "./live.mts"
import { isBusy, isVisible } from "../../shell/lifecycle.mts"
import { type Own, remembered } from "../../shell/state.mts"
import { HOUR } from "../../shared/time.mts"

// A ride is over this long after the last word of it, though no bus ride takes nearly as long
const RIDE_MS = 2 * HOUR
// Fixes kept for lining up with buses' reports, which can be this old
const HISTORY_MS = 3 * 60_000
// Reports in a row that make it clear: with the bus, and having gone somewhere together
const AGREEING = 2
const MIN_TOGETHER = 100 // m
// Reports in a row apart from the bus you're on that mean you got off
const DISAGREEING = 2
// A bus you said you're not on isn't suggested again for this long
const DECLINED_MS = 10 * 60_000
// Further than this from the bus's route, you've stepped off it, or your GPS has wandered off the street
const ON_ROUTE = 25 // m
// The fastest a bus moves along its route. A fix further along than that since the last has found some other stretch
// of it
const MAX_SPEED = 25 // m/s

/** The bus as your phone has it: where you are on its route, how sure that is, how fast you're going, and which way */
const asBus = (vehicle: Vehicle, fix: Fix, { lat, lon }: { lat: number, lon: number }): Fixed => ({
  ...vehicle,
  lat,
  lon,
  accuracy: fix.accuracy,
  heading: fix.heading ?? vehicle.heading,
  kph: fix.speed === undefined ? vehicle.kph : fix.speed * 3.6,
  gpsTime: fix.at,
  secsSinceReport: Math.max(0, (Date.now() - fix.at) / 1000)
})

/** Which bus you're on, from where your phone is and where the buses report. own is given what stops it */
export const createRiding = (
  { feed, location, fused, lastUpdate, vehicles }: MapData & ReturnType<typeof createLocation> & ReturnType<typeof createLive>,
  own: Own
) => {
  /** The bus you're on, by vehicle id, remembered so a reload, like one for newer code, doesn't forget it */
  const riding = remembered<string | undefined>("map-riding",
    stored => {
      const { id, at } = Object(stored) as { id?: unknown, at?: unknown }
      return typeof id === "string" && typeof at === "number" && Date.now() - at < RIDE_MS ? id : undefined
    },
    id => id === undefined ? null : { id, at: Date.now() }
  )
  // Newer code waits until you're off it, as a reload would lose which bus you're on
  own(watch([riding], () => {
    isBusy.value = riding.value !== undefined
  }))
  /** A bus you seem to be on, to ask about */
  const suggested = r<string>()

  let history: Fix[] = []
  own(watch(() => {
    const fix = location.value
    if (!fix)
      return
    history = [...history.filter(old => old.at >= fix.at - HISTORY_MS && old.at < fix.at), fix]
  }))

  /** Whether your phone and the bus you're on agreed when it last reported */
  const isInStep = r(false)

  /** Each bus's run of reports with you or apart from you, and where you were when it started agreeing */
  const streaks = new Map<string, { with: number, apart: number, since?: Fix, gpsTime: number }>()
  const declined = new Map<string, number>()

  own(watch([vehicles], () => {
    for (const vehicle of vehicles.value) {
      const streak = streaks.get(vehicle.id) ?? { with: 0, apart: 0, gpsTime: 0 }
      streaks.set(vehicle.id, streak)
      if (vehicle.gpsTime <= streak.gpsTime)
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
        // Only clearly with the bus counts, as somewhere in between is often you having just stepped off
        if (you)
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
  }))

  // A bus that's stopped reporting can't keep agreeing with you, so you're off it, though it isn't declined, in case
  // it was only quiet for a while. Until Umo has answered once, as just after a reload, no bus has stopped
  own(watch(() => {
    if (riding.value !== undefined && lastUpdate.value !== undefined && !vehicles.value.some(vehicle => vehicle.id === riding.value))
      riding.value = undefined
  }))

  /** Says you're on a bus, or with undefined that you got off */
  const ride = (id: string | undefined) => {
    // A bus you've just got off is still beside you, so it isn't suggested straight back
    const was = riding.peek()
    if (was && was !== id)
      declined.set(was, Date.now())
    // A suggestion is already in step; a bus you picked waits for its next report to agree
    isInStep.value = id !== undefined && id === suggested.peek()
    suggested.value = undefined
    riding.value = id
  }

  const decline = (id: string) => {
    declined.set(id, Date.now())
    if (suggested.peek() === id)
      suggested.value = undefined
  }

  /** Where on the route of the bus you're on you are, while you're on it, as a bus can't leave the street */
  const onRoute = r<{ lat: number, lon: number }>()
  let last: Following<RouteLine> | undefined
  own(watch(() => {
    const fix = location.value
    const route = riding.value && vehicles.peek().find(vehicle => vehicle.id === riding.value)?.route?.id
    if (!fix || !route) {
      last = undefined
      onRoute.value = undefined
      return
    }
    const followed = follow(routeLines(feed.peek()).get(route) ?? [], fix, last, { ...BUS_TRACKING, within: ON_ROUTE, speed: MAX_SPEED })
    if (followed)
      last = followed
    onRoute.value = followed && { lon: followed.point[0], lat: followed.point[1] }
  }))

  // Every bus, with the one you're on where your phone says it is, when that's newer than its own report and on its route
  own(watch(() => {
    const id = riding.value
    const fix = location.value
    fused.value = !id || !fix || !isInStep.value
      ? vehicles.value
      : vehicles.value.map(vehicle =>
        vehicle.id !== id || fix.at <= vehicle.gpsTime || !onRoute.value ? vehicle : asBus(vehicle, fix, onRoute.value)
      )
  }))

  // The screen stays on while you're riding, to watch for your stop
  let wakeLock: Promise<WakeLockSentinel | undefined> | undefined
  const holdScreen = () => {
    if (riding.peek() && !wakeLock && isVisible.peek())
      wakeLock = navigator.wakeLock?.request("screen").catch(() => undefined)
  }
  const letGo = () => {
    wakeLock?.then(lock => lock?.release())
    wakeLock = undefined
  }
  own(watch([riding], () => riding.value ? holdScreen() : letGo()))
  // The lock is let go whenever the page is hidden, so it's taken again on coming back
  own(watch([isVisible], () => {
    if (isVisible.value)
      holdScreen()
    else
      wakeLock = undefined
  }))
  own(letGo)

  return { riding, suggested, ride, decline }
}
