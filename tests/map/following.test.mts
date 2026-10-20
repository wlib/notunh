import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { flush, r } from "bruh/reactive"
import { withIndexes, type FeedData } from "../../src/transit/feed.mts"
import { extract } from "../../src/transit/inference/events.mts"
import { unpackFixes, type RawFix } from "../../src/transit/observations/raw.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { update } from "../../src/transit/models/fit.mts"
import { NO_PACE } from "../../src/transit/models/movement.mts"
import { routeLines } from "../../src/transit/shapes.mts"
import { type Fixed, follow } from "../../src/map/state/following.mts"

// The recording replay.test.mts scores: half an hour of seven buses' fixes, and the timetable then
const { feed: data, rows }: { feed: FeedData, rows: { source: string, at: number, body: unknown[] }[] } =
  JSON.parse(gunzipSync(readFileSync(new URL("fixtures/buses.json.gz", import.meta.url))).toString())
const fixes = rows.filter(row => row.source === "buses").flatMap(row => unpackFixes(row.at, { version: 0, samples: row.body as RawFix[], polls: null }))
  .sort((a, b) => a.at - b.at)
const learned = update(emptyModel(), "2026-10-06", extract(withIndexes(data), fixes))

/** The map following the buses through the first part of the recording, as the page's state does, by a model */
const following = (share: number) => {
  const [feed, model, vehicles] = [r(withIndexes(data)), r(learned), r<Fixed[]>([])]
  const { followed, sightings } = follow(feed, model, vehicles)
  const latest = new Map<string, Fixed>()
  for (const fix of fixes.slice(0, Math.floor(share * fixes.length))) {
    latest.set(fix.vehicle, {
      id: fix.vehicle, lat: fix.lat, lon: fix.lon, gpsTime: fix.at, secsSinceReport: 0, heading: fix.heading, kph: fix.kph,
      route: fix.route === null ? null : { id: fix.route }, dir: null, tripTag: fix.trip
    })
    vehicles.value = [...latest.values()]
    flush()
  }
  return { feed, model, vehicles, followed, sightings }
}

test("a newer model keeps where each bus is, as that's what its fixes say, and starts its pace afresh and draws its course by the new model at once", () => {
  const { model, followed, sightings } = following(0.6)
  const before = followed.value
  expect([...before.values()].some(({ pace }) => pace !== NO_PACE)).toBe(true)
  model.value = update(learned, "2026-10-07", [])
  flush()
  for (const [id, { vehicle, location, pace, course }] of followed.value) {
    expect(vehicle).toEqual(before.get(id)!.vehicle)
    expect(location).toBe(before.get(id)!.location)
    expect(pace).toBe(NO_PACE)
    expect(course === undefined).toBe(location === undefined)
    if (course)
      expect(course).not.toBe(before.get(id)!.course)
  }
  for (const sighting of sightings.value)
    expect(sighting.pace).toBe(NO_PACE)
})

test("a newer timetable follows each bus afresh along its lines from its last fix, at once", () => {
  const { feed, followed } = following(0.6)
  const before = followed.value
  feed.value = withIndexes(structuredClone(data))
  flush()
  const lines = routeLines(feed.peek())
  expect([...followed.value.keys()]).toEqual([...before.keys()])
  for (const { vehicle, location, pace } of followed.value.values()) {
    expect(pace).toBe(NO_PACE)
    if (location) {
      expect(lines.get(vehicle.route!.id)).toContain(location.line)
      expect(location.at).toBe(vehicle.gpsTime / 1000)
    }
  }
  expect([...followed.value.values()].some(({ location }) => location)).toBe(true)
})
