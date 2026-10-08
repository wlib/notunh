// Every fix the buses report: moving ones report about every 11 s and stopped ones every 30 s, so polling every 10 s
// misses only the odd pair of fixes a few seconds apart

import { STALE_VEHICLE_SECONDS, fetchVehicles, type Vehicle } from "../src/map/umo.mts"
import { packFixes, type RawFix } from "../src/map/raw.mts"
import { HEADERS, type Source } from "./collect.mts"

export const POLLS = 6
const POLL_MS = 10_000

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

export const buses: Source<RawFix> = {
  name: "buses",
  cron: "* * * * *",
  collect: async (at, signal) => {
    const started = Date.now()
    const seen = new Set<string>()
    const fixes: RawFix[] = []
    for (let poll = 0; poll < POLLS && !signal.aborted; poll++) {
      if (poll)
        await sleep(started + poll * POLL_MS - Date.now())
      try {
        const fresh: Vehicle[] = []
        for (const vehicle of await fetchVehicles(AbortSignal.any([signal, AbortSignal.timeout(POLL_MS)]), HEADERS)) {
          const key = `${vehicle?.id} ${vehicle?.gpsTime}`
          // Parked buses repeat the same old fix all day
          if (vehicle?.secsSinceReport <= STALE_VEHICLE_SECONDS && !seen.has(key)) {
            seen.add(key)
            fresh.push(vehicle)
          }
        }
        fixes.push(...packFixes(at, fresh))
      }
      catch (error) {
        // A missed poll costs a few fixes, and the rest of the minute still counts
        console.warn(error)
      }
    }
    return fixes
  }
}
