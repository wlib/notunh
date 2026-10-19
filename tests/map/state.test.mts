import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { type FeedData, serviceDayStart } from "../../src/map/feed.mts"
import { distance } from "../../src/geo/projection.mts"
import type { Vehicle } from "../../src/map/umo.mts"
import { type Place, itineraryKey } from "../../src/map/plan.mts"
import type { Building } from "../../src/map/places.mts"
import places from "../../src/map/places.json"
import { localDay } from "../../src/shared/time.mts"
import { fakePage, headOf, leavePage } from "../shell/page.mts"

// Each run loads the app's state afresh, which is slower than the pure properties
fc.configureGlobal({ numRuns: 40 })

const STALE = 180 // s
const TICK = 15_000
// Midday in Durham, with hours to go before the day changes
const NOON = Date.UTC(2026, 9, 7, 16)
const CENTER = { lat: 43.135, lon: -70.93 }
const MADE = { extract: "2026-10-13", generator: "0000000000000000" }

const FEED: FeedData = {
  version:  "test",
  start:    "2000-01-01",
  end:      "2099-12-31",
  routes:   [{ id: "R", name: "R", long: "Route", color: "#000000", text: "#FFFFFF" }],
  stops:    [{ id: "0", name: "Stop", ...CENTER }],
  services: {},
  trips:    [],
  shapes:   {}
}

// As the map's page names them in development
const DATA = Object.fromEntries(["gtfs", "model", "walk", "gazetteer", "tiles", "style", "places"].map(name => [name, `/src/map/${name}.json`]))
const BUILDINGS = places as Building[]

const bus = (id: string, secsSinceReport = 0): Vehicle => ({
  id, ...CENTER, heading: 0, kph: 0, secsSinceReport, gpsTime: NOON - secsSinceReport * 1000,
  route: { id: "R" }, dir: null
})

afterEach(() => {
  leavePage()
  vi.restoreAllMocks()
})

/**
 * The map's state loaded afresh at a time, with Umo answering with whatever umo is set to, or failing while it's
 * undefined, a phone whose location is shared as told, and the page opened at a query
 */
const load = async ({ at = NOON, saved = {} as Record<string, unknown>, permission = "granted", isUmoUp = true, search = "", files = {} as Record<string, unknown> } = {}) => {
  const page = fakePage({ at, saved: Object.fromEntries(Object.entries(saved).map(([key, value]) => [key, JSON.stringify(value)])), data: DATA })
  const replaceState = vi.fn()
  vi.stubGlobal("location", { reload: page.reload, pathname: "/map/", search })
  vi.stubGlobal("history", { state: null, replaceState })
  vi.spyOn(console, "error").mockImplementation(() => {})
  let take: PositionCallback | undefined
  const umo: { vehicles?: () => Promise<Vehicle[]> } = { vehicles: isUmoUp ? async () => [] : undefined }
  vi.stubGlobal("isSecureContext", true)
  vi.stubGlobal("navigator", {
    geolocation: { watchPosition: (callback: PositionCallback) => (take = callback, 1), clearWatch: () => {} },
    permissions: { query: async () => ({ state: permission }) }
  })
  vi.stubGlobal("fetch", async (url: string) => {
    if (url in files)
      return Response.json(files[url])
    // No walking network, so walks are straight lines, as off it
    if (url.includes("walk.json"))
      return Response.json({ made: MADE, vertices: [], edges: [] })
    if (url.includes("gazetteer.json"))
      return Response.json({ made: MADE, places: [] })
    if (url.includes("tiles.json"))
      return Response.json({ version: "2026-10-17", folders: ["/data/map/tiles/2026-10-17/"] })
    if (url.includes("style.json"))
      return Response.json({ url: "/data/map/AAAAAAAAAAAAAAAA/style.json", folders: ["/data/map/AAAAAAAAAAAAAAAA/"] })
    if (url.includes("places.json"))
      return Response.json(BUILDINGS)
    if (!url.endsWith("/vehicles"))
      return Response.json(FEED)
    if (!umo.vehicles)
      throw new TypeError("Load failed")
    return Response.json(await umo.vehicles())
  })
  const state = await import("../../src/map/state.mts")
  const { ride } = await import("../../src/map/riding.mts")
  const { receive } = await import("../../src/shell/build.mts")
  await vi.advanceTimersByTimeAsync(0)
  return {
    ...state,
    ride,
    receive,
    umo,
    replaceState,
    storage: page.storage,
    setVisibility: async (state: DocumentVisibilityState) => {
      page.setVisibility(state)
      await vi.advanceTimersByTimeAsync(0)
    },
    /** A GPS fix from the phone, just taken */
    moveTo: async ({ lat, lon }: { lat: number, lon: number }) => {
      take!({ coords: { latitude: lat, longitude: lon, accuracy: 5, speed: null, heading: null }, timestamp: Date.now() } as GeolocationPosition)
      await vi.advanceTimersByTimeAsync(0)
    }
  }
}

const ids = (vehicles: readonly Vehicle[]) =>
  vehicles.map(vehicle => vehicle.id)

test("buses drop off as they age, though Umo can't be reached to say so", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 6 }),
    fc.integer({ min: 0, max: 10 * 60_000 }),
    async (ages, elapsed) => {
      const reports = ages.map((age, i) => bus(`${i}`, age))
      const state = await load()
      state.umo.vehicles = async () => reports
      await vi.advanceTimersByTimeAsync(5_000)
      const updated = state.lastUpdate.peek()!
      state.umo.vehicles = undefined
      await vi.advanceTimersByTimeAsync(elapsed)

      // The clock ticks every 15 s from loading
      const now = NOON + Math.floor((5_000 + elapsed) / TICK) * TICK
      const unheard = Math.max(0, now - updated) / 1000
      expect(ids(state.vehicles.peek())).toEqual(ids(reports.filter(({ secsSinceReport }) => secsSinceReport + unheard < STALE)))
      expect([...state.liveCounts.peek().values()].reduce((sum, count) => sum + count, 0)).toBe(state.vehicles.peek().length)
      expect(state.ageOf(reports[0] ?? bus("x"), Date.now())).toBe((reports[0]?.secsSinceReport ?? 0) + (Date.now() - updated) / 1000)
    }
  ))
})

test("the list of buses is the same list while the same buses are in it", async () => {
  const state = await load()
  const reports = [bus("a", 0), bus("b", 100)]
  state.umo.vehicles = async () => reports
  await vi.advanceTimersByTimeAsync(5_000)
  const list = state.vehicles.peek()
  state.umo.vehicles = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(state.vehicles.peek()).toBe(list)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(ids(state.vehicles.peek())).toEqual(["a"])
})

test("live updates are down once Umo has been quiet for 30 s while the page is in view, until it answers", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 5 * 60_000 }),
    fc.integer({ min: 0, max: 50 * 60_000 }),
    fc.integer({ min: 0, max: 2 * 60_000 }),
    async (before, away, after) => {
      const state = await load()
      state.umo.vehicles = async () => [bus("a")]
      await vi.advanceTimersByTimeAsync(0)
      const updated = state.lastUpdate.peek()!
      state.umo.vehicles = undefined
      await vi.advanceTimersByTimeAsync(before)
      await state.setVisibility("hidden")
      await vi.advanceTimersByTimeAsync(away)
      // Coming back gives Umo a moment to answer, unless it had already gone quiet
      const wasDown = NOON + Math.floor(before / TICK) * TICK - updated > 30_000
      await state.setVisibility("visible")
      const resumed = Date.now()
      expect(state.isLiveDown.peek()).toBe(wasDown)
      await vi.advanceTimersByTimeAsync(after)

      const ticked = NOON + Math.floor((Date.now() - NOON) / TICK) * TICK
      const now = Math.max(ticked, resumed)
      expect(state.isLiveDown.peek()).toBe(wasDown || now - Math.max(updated, resumed) > 30_000)

      state.umo.vehicles = async () => [bus("a")]
      await vi.advanceTimersByTimeAsync(5_000)
      expect(state.isLiveDown.peek()).toBe(false)
    }
  ))
})

test("live updates are down when Umo has never answered", async () => {
  const state = await load({ isUmoUp: false })
  expect(state.lastUpdate.peek()).toBeUndefined()
  expect(state.isLiveDown.peek()).toBe(true)
})

test("a ride ends when its bus stops reporting, or Umo stops listing it, and holds off newer code meanwhile", async () => {
  const state = await load()
  const { isBusy } = await import("../../src/shell/lifecycle.mts")
  state.umo.vehicles = async () => [bus("a", 100), bus("b")]
  await vi.advanceTimersByTimeAsync(5_000)
  expect(isBusy.peek()).toBe(false)
  state.ride("a")
  await vi.advanceTimersByTimeAsync(0)
  expect(state.riding.peek()).toBe("a")
  expect(isBusy.peek()).toBe(true)
  state.umo.vehicles = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(state.riding.peek()).toBe("a")
  await vi.advanceTimersByTimeAsync(30_000)
  expect(state.riding.peek()).toBeUndefined()
  expect(isBusy.peek()).toBe(false)

  state.umo.vehicles = async () => [bus("b")]
  await vi.advanceTimersByTimeAsync(5_000)
  state.ride("b")
  state.umo.vehicles = async () => []
  await vi.advanceTimersByTimeAsync(5_000)
  expect(state.riding.peek()).toBeUndefined()
})

test("buses that aged out while Umo was down stay gone after the page is away and back", async () => {
  const state = await load()
  state.umo.vehicles = async () => [bus("a", 100), bus("b")]
  await vi.advanceTimersByTimeAsync(5_000)
  state.umo.vehicles = undefined
  await vi.advanceTimersByTimeAsync(85_000)
  expect(ids(state.vehicles.peek())).toEqual(["b"])
  await state.setVisibility("hidden")
  expect(ids(state.vehicles.peek())).toEqual(["b"])
  await vi.advanceTimersByTimeAsync(120_000)
  await state.setVisibility("visible")
  expect(state.isLiveDown.peek()).toBe(true)
  expect(ids(state.vehicles.peek())).toEqual([])
})

test("a ride outlasts the phone sleeping, until Umo has a chance to answer", async () => {
  const state = await load()
  state.umo.vehicles = async () => [bus("a")]
  await vi.advanceTimersByTimeAsync(5_000)
  state.ride("a")
  await state.setVisibility("hidden")
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  let answer: (vehicles: Vehicle[]) => void = () => {}
  state.umo.vehicles = () => new Promise(resolve => answer = resolve)
  await state.setVisibility("visible")
  expect(state.riding.peek()).toBe("a")
  expect(ids(state.vehicles.peek())).toEqual(["a"])
  answer([bus("a")])
  await vi.advanceTimersByTimeAsync(0)
  expect(state.riding.peek()).toBe("a")
})

test("a ride outlasts a reload, as for newer code, while its bus is still out, and no longer than a ride can", async () => {
  const state = await load()
  state.umo.vehicles = async () => [bus("a")]
  await vi.advanceTimersByTimeAsync(5_000)
  state.ride("a")
  await vi.advanceTimersByTimeAsync(0)
  const saved = { "map-riding": JSON.parse(state.storage.get("map-riding")!) }

  // Until Umo answers, the bus is taken to be out still
  const reloaded = await load({ at: NOON + 60_000, saved, isUmoUp: false })
  expect(reloaded.riding.peek()).toBe("a")
  await vi.advanceTimersByTimeAsync(5_000)
  expect(reloaded.riding.peek()).toBe("a")
  reloaded.umo.vehicles = async () => [bus("a")]
  await vi.advanceTimersByTimeAsync(5_000)
  expect(reloaded.riding.peek()).toBe("a")

  const later = await load({ at: NOON + 60_000, saved, isUmoUp: false })
  later.umo.vehicles = async () => [bus("b")]
  await vi.advanceTimersByTimeAsync(5_000)
  expect(later.riding.peek()).toBeUndefined()

  const muchLater = await load({ at: NOON + 3 * 3_600_000, saved })
  expect(muchLater.riding.peek()).toBeUndefined()
})

const steps = fc.array(
  fc.tuple(fc.integer({ min: -60, max: 60 }), fc.integer({ min: -60, max: 60 })),
  { maxLength: 12 }
)

test("a trip from your location follows you once you've moved 50 m, and a trip from elsewhere stays put", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), steps, async (isYou, moves) => {
    const start: Place = { ...CENTER, name: isYou ? "Your location" : "Dimond Library", ...isYou ? { isYou: true } : {} }
    const state = await load({ saved: { "map-trip": { day: localDay(NOON), from: start } } })
    let you: Place | undefined
    let here = { ...CENTER }
    for (const [north, east] of moves) {
      here = { lat: here.lat + north * 1e-5, lon: here.lon + east * 1.4e-5 }
      await state.moveTo(here)
      if (!you || distance(you, here) >= 50)
        you = { ...here, name: "Your location", isYou: true }
      expect(state.from.peek()).toEqual(isYou ? you : start)
    }
  }))
})

test("a trip from your location stays put while you're on a bus, and catches up once you're off", async () => {
  const state = await load({ saved: { "map-trip": { day: localDay(NOON), from: { ...CENTER, name: "Your location", isYou: true } } } })
  state.umo.vehicles = async () => [bus("a")]
  await vi.advanceTimersByTimeAsync(5_000)
  state.ride("a")
  const away = { lat: CENTER.lat + 0.01, lon: CENTER.lon }
  await state.moveTo(away)
  expect(state.from.peek()).toMatchObject(CENTER)
  state.ride(undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(state.from.peek()).toMatchObject(away)
})

test("a trip is kept for the rest of the day, so a reload picks it back up", async () => {
  const dimond = { lat: 43.1351, lon: -70.9334, name: "Dimond Library" }
  const state = await load()
  state.from.value = { ...CENTER, name: "Stop" }
  state.to.value = dimond
  state.selected.value = "walk"
  await vi.advanceTimersByTimeAsync(0)
  const saved = { "map-trip": JSON.parse(state.storage.get("map-trip")!) }

  const reloaded = await load({ at: NOON + 3 * 3_600_000, saved })
  expect(reloaded.from.peek()).toEqual({ ...CENTER, name: "Stop" })
  expect(reloaded.to.peek()).toEqual(dimond)
  expect(reloaded.selected.peek()).toBe("walk")

  const tomorrow = await load({ at: NOON + 24 * 3_600_000, saved })
  expect(tomorrow.from.peek()).toBeUndefined()
  expect(tomorrow.to.peek()).toBeUndefined()
  expect(tomorrow.selected.peek()).toBeUndefined()
})

test("a kept trip from your location is dropped when your location can't be followed", async () => {
  const saved = { "map-trip": { day: localDay(NOON), from: { ...CENTER, name: "Your location", isYou: true }, to: { ...CENTER, name: "Stop" } } }
  const state = await load({ saved, permission: "prompt" })
  expect(state.from.peek()).toBeUndefined()
  expect(state.to.peek()).toEqual({ ...CENTER, name: "Stop" })
})

test("anything else kept under the trip's name is ignored", async () => {
  for (const trip of [null, "trip", 3, [], { day: localDay(NOON), from: { lat: "43", lon: -70, name: "Stop" }, selected: 4 }]) {
    const state = await load({ saved: { "map-trip": trip } })
    expect(state.from.peek()).toBeUndefined()
    expect(state.selected.peek()).toBeUndefined()
  }
})

const today = { day: localDay(NOON), from: { ...CENTER, name: "Stop" }, to: { ...CENTER, name: "Dimond Library" }, selected: "walk" }

test("a link to a building gives directions there from your location, over a kept trip, and only once", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...BUILDINGS),
    fc.boolean(),
    fc.option(fc.constant(today), { nil: undefined }),
    async (building, isByRoom, trip) => {
      const link = isByRoom && building.rooms ? `${building.kind}/${building.rooms.at(-1)}` : building.id
      const state = await load({ search: `?to=${link}`, saved: trip ? { "map-trip": trip } : {} })
      const there = { lat: building.lat, lon: building.lon, name: building.name }
      expect(state.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/map/")
      expect(state.to.peek()).toEqual(there)
      expect(state.from.peek()).toBeUndefined()
      expect(state.selected.peek()).toBeUndefined()

      await state.moveTo(CENTER)
      expect(state.from.peek()).toEqual({ ...CENTER, name: "Your location", isYou: true })

      // The page reloads without the link, and keeps the trip as it's since been changed
      state.to.value = { ...CENTER, name: "Stop" }
      await vi.advanceTimersByTimeAsync(0)
      const reloaded = await load({ saved: { "map-trip": JSON.parse(state.storage.get("map-trip")!) } })
      expect(reloaded.to.peek()).toEqual({ ...CENTER, name: "Stop" })
      expect(reloaded.replaceState).not.toHaveBeenCalled()
    }
  ))
})

test("a link to anywhere unknown is dropped, and the kept trip with it left as it was", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async to => {
    fc.pre(!BUILDINGS.some(building => building.id === to || building.rooms?.some(room => `${building.kind}/${room}` === to)))
    const state = await load({ search: `?${new URLSearchParams({ to })}`, saved: { "map-trip": today } })
    expect(state.replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/map/")
    expect(state.from.peek()).toEqual(today.from)
    expect(state.to.peek()).toEqual(today.to)
    expect(state.selected.peek()).toBe("walk")
  }))
})

test("a link asks for your location where it isn't yet shared, and plans from there once it is", async () => {
  const saved = { "map-trip": { ...today, from: { ...CENTER, name: "Your location", isYou: true } } }
  const state = await load({ search: "?to=dining/holloway-commons", saved, permission: "prompt" })
  expect(state.from.peek()).toBeUndefined()
  expect(state.to.peek()).toMatchObject({ name: "Holloway Commons" })
  await state.moveTo(CENTER)
  expect(state.from.peek()).toEqual({ ...CENTER, name: "Your location", isYou: true })
})

/** A spot some meters east and north of the center */
const metersFrom = (east: number, north: number) =>
  ({ lat: CENTER.lat + north / 111_100, lon: CENTER.lon + east / 81_360 })

test("walking from your location, stepping well off the way for a few fixes plans again from there, once", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 3, max: 8 }), async away => {
    const there = { ...metersFrom(400, 0), name: "Dimond Library" }
    const saved = { "map-trip": { day: localDay(NOON), from: { ...CENTER, name: "Your location", isYou: true }, to: there, selected: "walk" } }
    const state = await load({ saved })
    const fixAt = async (spot: { lat: number, lon: number }) => {
      await state.moveTo(spot)
      await vi.advanceTimersByTimeAsync(1000)
    }

    // Along the way, which is followed, though not far enough to plan it again
    for (let meters = 0; meters <= 20; meters += 2)
      await fixAt(metersFrom(meters, 0))
    expect(state.from.peek()).toMatchObject(CENTER)
    expect(state.progress.peek()).toMatchObject({ missed: 0 })
    expect(state.progress.peek()!.distance).toBeGreaterThan(15)
    expect(state.legPaths.peek()[0]).toMatchObject({ via: "estimate" })
    expect(state.legPaths.peek()[0].coordinates[0][0]).toBeCloseTo(metersFrom(state.progress.peek()!.distance, 0).lon, 6)

    // Off it by 40 m, under the 50 m that plans again on its own, until it's clear you've left it
    const off = metersFrom(20, 40)
    const starts = new Set<Place | undefined>()
    for (let i = 0; i < away; i++) {
      await fixAt(off)
      starts.add(state.from.peek())
    }
    expect(starts.size).toBe(2)
    expect(state.from.peek()).toEqual({ ...off, name: "Your location", isYou: true })

    // The new way is followed from its start, short of where it's planned again for having moved on
    for (let step = 1; step <= 10; step++) {
      await fixAt({ lat: off.lat + (there.lat - off.lat) * step / 100, lon: off.lon + (there.lon - off.lon) * step / 100 })
      expect(state.progress.peek()).toMatchObject({ missed: 0 })
    }
    expect(state.from.peek()).toEqual({ ...off, name: "Your location", isYou: true })
  }), { numRuns: 6 })
})

const stopNamed = (id: string, i: number) => ({ id, name: `Stop ${id}`, lat: CENTER.lat + i * 1e-3, lon: CENTER.lon })

test("a newer build's timetable swaps in live, keeping the trip, the itinerary chosen, and the stop selected", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.stringMatching(/^[0-9]{1,3}$/), { minLength: 1, maxLength: 8 }),
    fc.func(fc.integer()),
    fc.nat(),
    fc.boolean(),
    async (ids, order, pick, isKept) => {
      const next = { ...FEED, version: "next", stops: [...ids].sort((a, b) => order(a) - order(b)).map(stopNamed) }
      const feed = { ...FEED, stops: ids.map(stopNamed) }
      const chosen = pick % ids.length
      if (!isKept)
        next.stops = next.stops.filter(stop => stop.id !== ids[chosen])
      const state = await load({ files: { "/src/map/gtfs.json": feed, "/assets/gtfs-BBBBBBBB.json": next } })
      const there = { ...CENTER, name: "Dimond Library" }
      state.from.value = { ...CENTER, name: "Stop" }
      state.to.value = there
      state.selected.value = "walk"
      state.selectedStop.value = chosen
      await vi.advanceTimersByTimeAsync(0)
      const trip = state.storage.get("map-trip")

      state.receive(headOf({ ...DATA, gtfs: "/assets/gtfs-BBBBBBBB.json" }))
      await vi.advanceTimersByTimeAsync(0)
      expect(state.feed.peek().version).toBe("next")
      expect(state.selectedStop.peek()).toBe(isKept ? next.stops.findIndex(stop => stop.id === ids[chosen]) : undefined)
      expect(state.selectedStopId.peek()).toBe(isKept ? ids[chosen] : undefined)
      expect(state.from.peek()).toEqual({ ...CENTER, name: "Stop" })
      expect(state.to.peek()).toBe(there)
      expect(state.selected.peek()).toBe("walk")
      expect(state.itinerary.peek()?.legs[0]).toMatchObject({ kind: "walk", to: there })
      expect(state.storage.get("map-trip")).toBe(trip)
    }
  ))
})

// A trip along three stops a couple of kilometers apart, each stop placed by its id so renumbering moves none
const stopById = (id: string) => ({ id, name: `Stop ${id}`, lat: CENTER.lat + Number(id) * 0.02, lon: CENTER.lon })
const tripFeed = (ids: string[]): FeedData => ({
  ...FEED,
  stops:    ids.map(stopById),
  services: { daily: { days: 127, start: "2000-01-01", end: "2099-12-31", added: [], removed: [] } },
  trips: [{
    id: "T", route: "R", service: "daily", headsign: "Town", shape: "", timepoints: [],
    stops: ["0", "1", "2"].map(id => ids.indexOf(id)),
    // Leaving a quarter of an hour after noon
    times: [0, 600, 1200].map(seconds => (NOON - serviceDayStart(localDay(NOON))) / 1000 + 900 + seconds)
  }]
})

test("a newer timetable with its stops numbered otherwise keeps the itinerary chosen, by the same stops", async () => {
  const state = await load({ files: { "/src/map/gtfs.json": tripFeed(["0", "1", "2"]), "/assets/gtfs-BBBBBBBB.json": { ...tripFeed(["2", "0", "1"]), version: "next" } } })
  state.from.value = { ...stopById("0"), lat: stopById("0").lat + 0.0005, name: "Home" }
  state.to.value = { ...stopById("2"), lat: stopById("2").lat + 0.0005, name: "Work" }
  await vi.advanceTimersByTimeAsync(0)
  const before = state.itinerary.peek()!
  const ride = before.legs.find(leg => leg.kind === "ride")!
  expect(ride).toMatchObject({ fromPosition: 0, toPosition: 2 })
  state.selected.value = itineraryKey(before)
  await vi.advanceTimersByTimeAsync(0)

  state.receive(headOf({ ...DATA, gtfs: "/assets/gtfs-BBBBBBBB.json" }))
  await vi.advanceTimersByTimeAsync(0)
  const feed = state.feed.peek()
  expect(feed.version).toBe("next")
  const after = state.itinerary.peek()!
  const rideAfter = after.legs.find(leg => leg.kind === "ride")!
  // The same itinerary, now over the new timetable's own trip, whose stops are found by the new numbering
  expect(itineraryKey(after)).toBe(itineraryKey(before))
  expect(after).not.toBe(before)
  expect(feed.trips).toContain(rideAfter.run.trip)
  expect([rideAfter.fromPosition, rideAfter.toPosition].map(position => feed.stops[rideAfter.run.trip.stops[position]].id)).toEqual(["0", "2"])
})

test("newer code leaves the data as it is, for the reload that brings both in", async () => {
  const state = await load({ files: { "/assets/gtfs-BBBBBBBB.json": { ...FEED, version: "next" } } })
  const { isNewBuild } = await import("../../src/shell/build.mts")
  state.receive(headOf({ ...DATA, gtfs: "/assets/gtfs-BBBBBBBB.json" }, ["/assets/index-BBBBBBBB.js"]))
  await vi.advanceTimersByTimeAsync(0)
  expect(state.feed.peek().version).toBe("test")
  expect(isNewBuild.peek()).toBe(true)
})
