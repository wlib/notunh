// What leaves the page with each usage event, decided before posthog-js sends it (usage.tsx gives it beforeSend):
// - Until someone says yes, only page views, page leaves, and errors go, which PostHog counts without storing anything
//   on the device
// - Every URL is cut to its origin and path, as a query or fragment can hold a search or a place, and every laundry
//   room's path reads as one, as a room says where someone lives
// - PostHog's lookup of a place from the IP address is off for every event
// - An unlinked event, like a trip planned, keeps only its own properties, under a random id of its own, with no
//   person, device, session, page, or URL, at the hour, so it can be counted but never tied to anyone or anything else

import type { CaptureResult, Properties } from "posthog-js/dist/module.slim.js"

/** What's counted for everyone, without storing anything on the device */
export const COUNTED = new Set(["$pageview", "$pageleave", "$exception"])

/** Events sent unlinked, by name, with the properties each keeps */
export const UNLINKED: Record<string, string[]> = {
  trip_planned: ["from", "to", "hour_of_week", "itineraries", "rides_bus", "walk_only"]
}

const HOUR_MS = 3_600_000

// Properties holding a URL or a path, like $current_url, $referrer, $initial_pathname, or $prev_pageview_pathname
const URL_KEY = /(url|referrer|pathname)$/
const ROOM = /^\/laundry\/[^/]+\//

/** A URL or path without its query or fragment, a laundry room's as any room's */
export const cutUrl = (url: string) => {
  const { origin, pathname } = parsed(url) ?? { origin: "", pathname: url.split(/[?#]/)[0] }
  return origin + pathname.replace(ROOM, "/laundry/room/")
}

// URL.canParse is newer than Safari 16.4
const parsed = (url: string) => {
  try {
    return new URL(url)
  }
  catch {}
}

const cutUrls = (properties: Properties | undefined) =>
  properties && Object.fromEntries(Object.entries(properties).map(([key, value]) =>
    [key, URL_KEY.test(key) && typeof value === "string" ? cutUrl(value) : value]
  ))

/** An event as it may leave, given whether its browser said yes; null for one that mustn't */
export const beforeSend = (isYes: () => boolean) => (event: CaptureResult | null): CaptureResult | null => {
  if (!event || !isYes() && !COUNTED.has(event.event))
    return null
  const kept = UNLINKED[event.event]
  if (kept) {
    const at = event.timestamp?.getTime() ?? Date.now()
    return {
      uuid:       crypto.randomUUID(),
      event:      event.event,
      timestamp:  new Date(at - at % HOUR_MS),
      properties: {
        ...Object.fromEntries(kept.filter(key => key in event.properties).map(key => [key, event.properties[key]])),
        // The project's key, without which PostHog takes nothing
        token:                   event.properties.token,
        distinct_id:             crypto.randomUUID(),
        $process_person_profile: false,
        $geoip_disable:          true
      }
    }
  }
  return {
    ...event,
    properties: { ...cutUrls(event.properties), $geoip_disable: true },
    $set:       cutUrls(event.$set),
    $set_once:  cutUrls(event.$set_once)
  }
}
