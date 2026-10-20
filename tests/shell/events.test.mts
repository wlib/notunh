import { test, expect } from "vitest"
import fc from "fast-check"
import type { CaptureResult } from "posthog-js/dist/module.slim.js"
import { COUNTED, UNLINKED, beforeSend, cutUrl } from "../../src/shell/events.mts"

const TOKEN = "phc_key"
const AT = new Date("2026-10-20T14:37:12.345Z")

/** Whatever else posthog-js may put on an event, under any name, its own like $session_id among them */
const extra = fc.dictionary(
  fc.oneof(fc.string(), fc.constantFrom("distinct_id", "$device_id", "$session_id", "$window_id", "$user_id", "$pageview_id", "$prev_pageview_pathname", "$referrer", "$initial_referrer", "$referring_domain", "$current_url", "$pathname", "$host", "$set", "$set_once", "$ip", "$lib")),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.object())
)

const trip = { from: "Holloway Commons", to: "elsewhere", hour_of_week: 38, itineraries: 2, rides_bus: true, walk_only: false }

const event = (name: string, properties: Record<string, unknown>, more: Partial<CaptureResult> = {}): CaptureResult =>
  ({ uuid: "0192f2a4-0000-7000-8000-000000000000", event: name, properties: { ...properties, token: TOKEN }, timestamp: AT, ...more })

test("a trip planned keeps its ends, its hour, and its plan, under ids of its own at the hour, and nothing else of the event", () =>
  fc.assert(fc.property(extra, extra, extra, (properties, $set, $set_once) => {
    const sent = beforeSend(() => true)(event("trip_planned", { ...properties, ...trip }, { $set, $set_once }))!
    const { token, distinct_id, $process_person_profile, $geoip_disable, ...kept } = sent.properties
    expect(kept).toEqual(trip)
    expect(token).toBe(TOKEN)
    expect($process_person_profile).toBe(false)
    expect($geoip_disable).toBe(true)
    expect(distinct_id).not.toBe(properties.distinct_id)
    expect(sent.uuid).not.toBe("0192f2a4-0000-7000-8000-000000000000")
    expect(Object.keys(sent).sort()).toEqual(["event", "properties", "timestamp", "uuid"])
    expect(sent.timestamp).toEqual(new Date("2026-10-20T14:00:00.000Z"))
  }))
)

test("two trips planned on one device share no id", () => {
  const send = beforeSend(() => true)
  const [a, b] = [send(event("trip_planned", trip))!, send(event("trip_planned", trip))!]
  expect(a.uuid).not.toBe(b.uuid)
  expect(a.properties.distinct_id).not.toBe(b.properties.distinct_id)
})

test("until someone says yes only page views, page leaves, and errors go, and every event skips the lookup of a place by IP", () =>
  fc.assert(fc.property(fc.constantFrom(...COUNTED, "$autocapture", "$rageclick", "$web_vitals", "$opt_in", "trip_planned", "dining_searched"), fc.boolean(), (name, isYes) => {
    const sent = beforeSend(() => isYes)(event(name, {}))
    expect(sent === null).toBe(!isYes && !COUNTED.has(name))
    if (sent && !(name in UNLINKED))
      expect(sent.properties.$geoip_disable).toBe(true)
  }))
)

test("every URL goes without its query or fragment, and a laundry room's as any room's", () => {
  const sent = beforeSend(() => false)(event("$pageview", {
    $current_url:      "https://notunh.app/laundry/adams-tower/?from=home#machines",
    $pathname:         "/laundry/adams-tower/",
    $referrer:         "https://notunh.app/map/?to=laundry/stoke-hall-g05",
    $referring_domain: "notunh.app",
    $initial_referrer: "$direct",
    title:             "Laundry"
  }, { $set_once: { $initial_current_url: "https://notunh.app/dining/?q=tofu" } }))!
  expect(sent.properties).toMatchObject({
    $current_url:      "https://notunh.app/laundry/room/",
    $pathname:         "/laundry/room/",
    $referrer:         "https://notunh.app/map/",
    $referring_domain: "notunh.app",
    $initial_referrer: "$direct",
    title:             "Laundry"
  })
  expect(sent.$set_once).toEqual({ $initial_current_url: "https://notunh.app/dining/" })
  expect(cutUrl("/laundry/")).toBe("/laundry/")
})
