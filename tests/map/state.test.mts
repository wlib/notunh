import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { distance, type FeedData } from "../../src/map/feed.mts"
import type { Vehicle } from "../../src/map/umo.mts"
import type { Place } from "../../src/map/plan.mts"
import { BUILDINGS } from "../../src/map/places.mts"
import { localDay } from "../../src/shared/time.mts"
import { fakePage, leavePage } from "../shell/page.mts"

// Each run loads the app's state afresh, which is slower than the pure properties
fc.configureGlobal({ numRuns: 40 })

const STALE = 180 // s
const TICK = 15_000
// Midday in Durham, with hours to go before the day changes
const NOON = Date.UTC(2026, 9, 7, 16)
const CENTER = { lat: 43.135, lon: -70.93 }

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

const bus = (id: string, secsSinceReport = 0): Vehicle => ({
  id, ...CENTER, heading: 0, kph: 0, secsSinceReport, predictable: true, gpsTime: NOON - secsSinceReport * 1000,
  route: { id: "R", name: "R" }, dir: null
})

afterEach(() => {
  leavePage()
  vi.restoreAllMocks()
})

/**
 * The map's state loaded afresh at a time, with Umo answering with whatever umo is set to, or failing while it's
 * undefined, a phone whose location is shared as told, and the page opened at a query
 */
const load = async ({ at = NOON, saved = {} as Record<string, unknown>, permission = "granted", isUmoUp = true, search = "" } = {}) => {
  const page = fakePage({ at, saved: Object.fromEntries(Object.entries(saved).map(([key, value]) => [key, JSON.stringify(value)])) })
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
    if (!url.endsWith("/vehicles"))
      return Response.json(FEED)
    if (!umo.vehicles)
      throw new TypeError("Load failed")
    return Response.json(await umo.vehicles())
  })
  const state = await import("../../src/map/state.mts")
  const { ride } = await import("../../src/map/riding.mts")
  await vi.advanceTimersByTimeAsync(0)
  return {
    ...state,
    ride,
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

test("a ride ends when its bus stops reporting, or Umo stops listing it", async () => {
  const state = await load()
  state.umo.vehicles = async () => [bus("a", 100), bus("b")]
  await vi.advanceTimersByTimeAsync(5_000)
  state.ride("a")
  await vi.advanceTimersByTimeAsync(0)
  expect(state.riding.peek()).toBe("a")
  state.umo.vehicles = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(state.riding.peek()).toBe("a")
  await vi.advanceTimersByTimeAsync(30_000)
  expect(state.riding.peek()).toBeUndefined()

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
