import { test, expect } from "vitest"
import { flush, r } from "bruh/reactive"
import { withIndexes } from "../../src/transit/feed.mts"
import { extract } from "../../src/transit/inference/events.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { update } from "../../src/transit/models/fit.mts"
import { NO_PACE } from "../../src/transit/models/movement.mts"
import { routeLines } from "../../src/transit/shapes.mts"
import { buildRuns } from "../../src/transit/models/forecast.mts"
import { localDay } from "../../src/shared/time.mts"
import { type Fixed, drawing, follow } from "../../src/map/state/following.mts"
import { recordedData as data, recordedFeed, recordedFixes } from "./fixtures/recording.mts"

// The recording replay.test.mts scores, its fixes in order
const fixes = recordedFixes.toSorted((a, b) => a.at - b.at)
const learned = update(emptyModel(), "2026-10-06", extract(recordedFeed, fixes))

/** The map following the buses through the first part of the recording, as the page's state does, by a model */
const following = (share: number) => {
  const [feed, model, vehicles] = [r(withIndexes(data)), r(learned), r<Fixed[]>([])]
  const { followed, sightings } = follow(feed, model, vehicles)
  const runs = r(() => buildRuns(feed.value, localDay(fixes[0].at), undefined, model.value, sightings.value))
  const drawn = drawing(model, followed, runs)
  const latest = new Map<string, Fixed>()
  for (const fix of fixes.slice(0, Math.floor(share * fixes.length))) {
    latest.set(fix.vehicle, {
      id: fix.vehicle, lat: fix.lat, lon: fix.lon, gpsTime: fix.at, secsSinceReport: 0, heading: fix.heading, kph: fix.kph,
      route: fix.route === null ? null : { id: fix.route }, dir: null, tripTag: fix.trip
    })
    vehicles.value = [...latest.values()]
    flush()
  }
  return { feed, model, vehicles, followed, sightings, runs, drawn }
}

test("a newer model keeps where each bus is, as that's what its fixes say, and starts its pace afresh and draws its course by the new model at once", () => {
  const { model, drawn, sightings } = following(0.6)
  const before = drawn.value
  expect([...before.values()].some(({ pace }) => pace !== NO_PACE)).toBe(true)
  model.value = update(learned, "2026-10-07", [])
  flush()
  for (const [id, { vehicle, location, pace, course }] of drawn.value) {
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
