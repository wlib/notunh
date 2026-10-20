// Every fix the buses report: moving ones report about every 11 s and stopped ones every 30 s, so polling every 10 s
// misses only the odd pair of fixes a few seconds apart. Each poll is recorded, with how many live buses it listed,
// and each fix with the poll that first saw it

import { STALE_VEHICLE_SECONDS, fetchVehicles } from "../src/transit/observations/umo.mts"
import { packFixes, packPoll, type RawFix, type RawPoll } from "../src/transit/observations/raw.mts"
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
    const samples: RawFix[] = []
    const polls: RawPoll[] = []
    for (let poll = 0; poll < POLLS && !signal.aborted; poll++) {
      if (poll)
        await sleep(started + poll * POLL_MS - Date.now())
      const made = Date.now()
      try {
        // Parked buses repeat the same old fix all day
        const live = (await fetchVehicles(AbortSignal.any([signal, AbortSignal.timeout(POLL_MS)]), HEADERS))
          .filter(vehicle => vehicle.secsSinceReport <= STALE_VEHICLE_SECONDS)
        const fresh = live.filter(({ id, gpsTime }) => {
          const key = `${id} ${gpsTime}`
          const isNew = !seen.has(key)
          seen.add(key)
          return isNew
        })
        samples.push(...packFixes(at, fresh, polls.length))
        polls.push(packPoll(at, made, live.length))
      }
      catch (error) {
        // A missed poll costs a few fixes, and the rest of the minute still counts
        console.warn(error)
        polls.push(packPoll(at, made, null))
      }
    }
    return { samples, polls }
  }
}
