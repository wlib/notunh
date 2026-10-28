// The page's reminders (src/map/state/reminders.mts) against a Worker and a browser of their own: each tab is the
// module loaded afresh over the same storage, the Worker answers as told, and the service worker's push handler
// (src/sw/push.mts) reads the same storage

import { test, expect, vi, beforeEach, afterEach } from "vitest"
import { flush } from "bruh/reactive"
import { type Reminder, unplanned, watchOf } from "../../src/reminders/reminder.mts"
import { SHIFT, WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import { type Locate, queueOf } from "../../src/reminders/queue.mts"
import type { Visit } from "../../src/shared/visit.mts"
import { type MoveOn, type PushScope, startPush } from "../../src/sw/push.mts"
import { browserStorage } from "./browser.mts"

// Now, in seconds, as the page drops reminders of buses long gone: a Wednesday noon in term, which the page's clock is set to
const NOW = Date.UTC(2026, 9, 7, 16) / 1000
const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
const REMINDER: Reminder = {
  id: "r1", from: { lat: 43.13, lon: -70.93, name: "Here" }, to: { lat: 43.14, lon: -70.94, name: "MUB" }, way: "w",
  legs: [{ kind: "walk", walk: 240, to: "Kingsbury Hall" }, { kind: "ride", trip: "t", route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 900, expected: NOW + 900, isLive: true }, { kind: "walk", walk: 120, to: "MUB" }],
  start: NOW + 600, end: NOW + 1500, headsUp: 300
}

type Tab = typeof import("../../src/map/state/reminders.mts")
type Asked = { method: string, path: string, device?: string, secret?: string, watch?: unknown, body?: string }

let storage: ReturnType<typeof browserStorage>
/** What the Worker was asked, and how it answers: taking everything, unreachable, or refusing */
let asked: Asked[]
let worker: "up" | "down" | "refusing" | "full" | "limited"
/** Something to do once the Worker has answered, before the page hears */
let answered: (() => void) | undefined
let online: (() => void)[]
let isSubscribed: boolean

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW * 1000)
  storage = browserStorage()
  asked = []
  worker = "up"
  answered = undefined
  online = []
  isSubscribed = true
  const subscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/stub", keys: { p256dh: "BCVxsr7N", auth: "BTBZMqHH" } }) }
  const registration = { pushManager: { subscribe: async () => subscription, getSubscription: async () => isSubscribed ? subscription : null } }
  vi.stubGlobal("caches", storage.caches)
  vi.stubGlobal("navigator", { locks: storage.locks, serviceWorker: { ready: Promise.resolve(registration) } })
  vi.stubGlobal("window", { PushManager: true, Notification: { permission: "granted" }, addEventListener: (type: string, listener: () => void) => void (type === "online" && online.push(listener)) })
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "https://notunh.app")
    if (url.pathname === "/api/push/key")
      return Response.json({ key: KEY })
    // No cookie keeps a device here, so a device is made
    if (url.pathname === "/api/session")
      return new Response("No device here", { status: 401 })
    const body = init.body ? JSON.parse(init.body as string) as { device: string, watch: unknown } : undefined
    asked.push({ method: init.method ?? "GET", path: url.pathname + url.search, device: body?.device, secret: new Headers(init.headers).get("authorization") ?? undefined, watch: body?.watch, body: init.body as string | undefined })
    if (worker === "down")
      throw new TypeError("Failed to fetch")
    answered?.()
    return (
      worker === "refusing" ? new Response("Too far ahead", { status: 400 }) :
      worker === "full"     ? new Response("At most 10 reminders at once", { status: 409 }) :
      worker === "limited"  ? new Response("Too many reminders set from here; try again in a minute", { status: 429 }) :
                              new Response(null, { status: 204 })
    )
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A tab: the page's reminders loaded afresh, as another window's are */
const tab = async (): Promise<Tab> => {
  vi.resetModules()
  const loaded = await import("../../src/map/state/reminders.mts")
  await loaded.prepare()
  await loaded.loadKept()
  flush()
  return loaded
}

const states = (page: Tab) =>
  [...page.kept.peek().values()].map(({ id, state }) => `${id} ${state}`)

/** A service worker over the same storage, and the notifications it's shown, which moves class reminders on as the phone's does */
const serviceWorker = async () => {
  const store = await import("../../src/reminders/browser/store.mts")
  const { moveOn } = await import("../../src/reminders/browser/sync.mts")
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/stub", keys: { p256dh: "BCVxsr7N", auth: "BTBZMqHH" } }
  const shown: string[] = []
  const shownBodies: string[] = []
  let onPush: ((event: { data: { json(): unknown }, waitUntil(promise: Promise<unknown>): void }) => void) | undefined
  const scope = {
    addEventListener: (type: string, listener: unknown) => void (type === "push" && (onPush = listener as typeof onPush)),
    registration: {
      showNotification: async (title: string, { body }: NotificationOptions) => void (shown.push(title), shownBodies.push(body ?? "")),
      getNotifications: async () => []
    },
    clients: { matchAll: async () => [], openWindow: async () => {} },
    location: { origin: "https://notunh.app" }
  } as unknown as PushScope
  const moving: MoveOn = (id, wake) => moveOn(id, NOW, isSubscribed ? subscription : undefined, wake)
  startPush(scope, store, () => NOW, moving)
  return {
    shown,
    shownBodies,
    push: async (data: string) => {
      const waits: Promise<unknown>[] = []
      onPush!({ data: { json: () => JSON.parse(data) }, waitUntil: promise => void waits.push(promise) })
      await Promise.all(waits)
    }
  }
}

test("two tabs setting their first reminder at once share one device, and each reminder is set with the Worker once", async () => {
  const [a, b] = await Promise.all([tab(), tab()])
  await Promise.all([a.remind(a.ready.peek()!, REMINDER), b.remind(b.ready.peek()!, { ...REMINDER, id: "r2" })])
  expect(asked.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(["PUT /api/reminders/r1", "PUT /api/reminders/r2"])
  expect(new Set(asked.map(({ device }) => device)).size).toBe(1)
  expect(new Set(asked.map(({ secret }) => secret)).size).toBe(1)
  expect(asked[0].secret).toMatch(/^Bearer [\w-]{43}$/)
  // Every tab shows what's kept, the other's included, as does one opened after
  for (const page of [a, b, await tab()])
    expect(states(page).sort()).toEqual(["r1 set", "r2 set"])
})

test("a reminder the Worker took but the phone couldn't keep as set stays pending, and is set again with the same id when the map next loads", async () => {
  const page = await tab()
  answered = () => storage.setFailing(true)
  await page.remind(page.ready.peek()!, REMINDER)
  expect(states(page)).toEqual(["r1 setting"])
  storage.setFailing(false)
  answered = undefined
  const later = await tab()
  expect(asked.map(({ method, path }) => `${method} ${path}`)).toEqual(["PUT /api/reminders/r1", "PUT /api/reminders/r1"])
  expect(states(later)).toEqual(["r1 set"])
})

test("a reminder the Worker refuses, as too far ahead or one too many, is dropped, with why, and one it can't be told of, or that too many were set from the address for, is kept as setting until it can", async () => {
  const page = await tab()
  worker = "refusing"
  await expect(page.remind(page.ready.peek()!, REMINDER)).rejects.toThrow("400 Too far ahead")
  expect(states(page)).toEqual([])
  worker = "full"
  await expect(page.remind(page.ready.peek()!, REMINDER)).rejects.toThrow("409 At most 10 reminders at once")
  expect(states(page)).toEqual([])
  worker = "down"
  await page.remind(page.ready.peek()!, REMINDER)
  expect(states(page)).toEqual(["r1 setting"])
  worker = "limited"
  online.forEach(listener => listener())
  await vi.waitFor(() => expect(asked.filter(({ method }) => method === "PUT")).toHaveLength(3))
  expect(states(page)).toEqual(["r1 setting"])
  worker = "up"
  online.forEach(listener => listener())
  await vi.waitFor(() => expect(states(page)).toEqual(["r1 set"]))
})

test("a reminder cancelled offline is kept as cancelling, a push arriving meanwhile says it's cancelled, and the Worker hears once the phone's back online", async () => {
  const page = await tab()
  await page.remind(page.ready.peek()!, REMINDER)
  worker = "down"
  await page.cancel("r1")
  expect(states(page)).toEqual(["r1 cancelling"])
  const sw = await serviceWorker()
  await sw.push(pushOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 900, band: 60, isLive: true, status: "coming" }, at: NOW }))
  expect(sw.shown).toEqual(["Reminder cancelled"])
  worker = "up"
  online.forEach(listener => listener())
  await vi.waitFor(() => expect(states(page)).toEqual([]))
  expect(asked.at(-1)).toMatchObject({ method: "DELETE", path: `/api/reminders/r1?device=${asked[0].device}` })
  expect(asked.filter(({ method }) => method === "DELETE")).toHaveLength(2)
})

test("reminders pushes no longer reach are dropped on both sides when the map loads, and the device itself stays", async () => {
  const page = await tab()
  await page.remind(page.ready.peek()!, REMINDER)
  isSubscribed = false
  const later = await tab()
  expect(states(later)).toEqual([])
  expect(asked.at(-1)).toMatchObject({ method: "DELETE", path: `/api/push/devices/${asked[0].device}` })
  const store = await import("../../src/reminders/browser/store.mts")
  expect((await store.deviceKept())?.id).toBe(asked[0].device)
  // With nothing kept, there's nothing to tell the Worker when the map loads again
  const told = asked.length
  await tab()
  expect(asked).toHaveLength(told)
})

test("a reminder's trip is planned again when the map loads, and its watch replaced with the same id only when its leave time moved by SHIFT or its first bus changed", async () => {
  const page = await tab()
  await page.remind(page.ready.peek()!, REMINDER)
  await page.remind(page.ready.peek()!, { ...REMINDER, id: "r2" })
  const puts = () => asked.filter(({ method }) => method === "PUT").map(({ path, watch }) => `${path} ${JSON.stringify(watch)}`)
  expect(puts()).toHaveLength(2)
  // Planned again a little earlier, and with the same bus: nothing to tell
  await page.replan(kept => ({ ...kept, start: kept.start - SHIFT + 1 }))
  expect(puts()).toHaveLength(2)
  // r1 now leaves SHIFT later, r2 rides a later bus
  const ride = REMINDER.legs[1] as Extract<Reminder["legs"][number], { kind: "ride" }>
  await page.replan(kept => kept.id === "r1"
    ? { ...kept, start: kept.start + SHIFT }
    : { ...kept, legs: [kept.legs[0], { ...ride, trip: "t2", scheduled: ride.scheduled + 1200, expected: ride.expected + 1200 }, kept.legs[2]] })
  expect(puts().slice(2)).toEqual([
    `/api/reminders/r1 ${JSON.stringify({ at: NOW + 900, lead: 540, run: { stop: "101", route: "3", trip: "t" } })}`,
    `/api/reminders/r2 ${JSON.stringify({ at: NOW + 2100, lead: 540, run: { stop: "101", route: "3", trip: "t2" } })}`
  ])
  expect(states(page).sort()).toEqual(["r1 set", "r2 set"])
  const store = await import("../../src/reminders/browser/store.mts")
  expect((await store.reminderOf("r1"))?.start).toBe(REMINDER.start + SHIFT)
  expect((await store.reminderOf("r2"))?.legs[1]).toMatchObject({ trip: "t2" })
  // One that can't be planned now, or is being cancelled, is left as it is
  await page.cancel("r2")
  await page.replan(kept => kept.id === "r1" ? undefined : { ...kept, start: kept.start + 7200 })
  expect(puts()).toHaveLength(4)
})

test("only a trip still ahead, untold, is planned again: not one left for, past its time, or pushed about, and a replan the Worker refuses or can't take leaves the plan it still holds", async () => {
  const first = await tab()
  const store = await import("../../src/reminders/browser/store.mts")
  await first.remind(first.ready.peek()!, REMINDER)
  await first.remind(first.ready.peek()!, { ...REMINDER, id: "r2", start: NOW - 30 })
  await first.remind(first.ready.peek()!, { ...REMINDER, id: "r3", by: NOW - 1 })
  await first.remind(first.ready.peek()!, { ...REMINDER, id: "r4" })
  // r4's push came, which a tab opened after sees
  const sw = await serviceWorker()
  await sw.push(pushOf({ v: WAKE_VERSION, reminder: "r4", kind: "due", seen: { time: NOW + 900, band: 60, isLive: true, status: "coming" }, at: NOW - 60 }))
  const page = await tab()
  const puts = () => asked.filter(({ method }) => method === "PUT").map(({ path }) => path)
  expect(puts()).toHaveLength(4)
  const planned: string[] = []
  await page.replan(kept => {
    planned.push(kept.id)
    return { ...kept, start: kept.start + SHIFT }
  })
  expect(planned).toEqual(["r1"])
  expect(puts().slice(4)).toEqual(["/api/reminders/r1"])
  expect((await store.reminderOf("r1"))?.start).toBe(REMINDER.start + SHIFT)
  // Refused, the fresh plan is dropped for the one the Worker still watches
  worker = "refusing"
  await page.replan(kept => ({ ...kept, start: kept.start + SHIFT }))
  expect(puts()).toHaveLength(6)
  expect(await store.reminderOf("r1")).toMatchObject({ start: REMINDER.start + SHIFT, state: "set" })
  // Not taken just now, it's kept as setting, and told again once it can be
  worker = "limited"
  await page.replan(kept => ({ ...kept, start: kept.start + SHIFT }))
  expect(await store.reminderOf("r1")).toMatchObject({ start: REMINDER.start + 2 * SHIFT, state: "setting" })
  worker = "up"
  online.at(-1)!()
  await vi.waitFor(() => expect(states(page)).toContain("r1 set"))
  expect(puts()).toHaveLength(8)
})

/** A class's meetings, a day apart from tomorrow, in a room, as the courses would resolve its section */
const meetings = (where: string, count = 12): Visit[] =>
  Array.from({ length: count }, (_, i) => ({
    destination: { place: "Kingsbury Hall", where },
    arriveBy:    (NOW + (i + 1) * 86_400) * 1000,
    offset:      300_000,
    occurrence:  { id: `cs518-01:${i}`, title: "CS 518" }
  }))
const SECTION = "202610:12496"
const locate: Locate = () => ({ lat: 43.1361, lon: -70.9353, name: "Kingsbury Hall" })
const HERE = { ...REMINDER.from, isYou: true as const }

/** A class reminder for the first of some meetings, not planned yet, and its queue, set ten minutes ago */
const classReminder = (visits: Visit[]) => {
  const reminder = unplanned("c1", HERE, { visit: visits[0], to: locate(visits[0])! }, 900)
  return { reminder, queue: queueOf(reminder, SECTION, visits, locate, NOW - 600) }
}

/** What the Worker must never be told of a class: what it is, its section, or where */
const COURSE = /CS 518|202610:12496|N343|N113|Kingsbury/

test("a visit's reminder needs nothing saved or going, the Worker is asked what a trip's would ask, and never what the class is or where", async () => {
  const page = await tab()
  const visit = meetings("N343")[0]
  const forVisit: Reminder = { ...REMINDER, id: "v1", visit, by: REMINDER.end }
  await page.remind(page.ready.peek()!, forVisit)
  const { reminder, queue } = classReminder(meetings("N343"))
  await page.remind(page.ready.peek()!, reminder, queue)
  await page.remind(page.ready.peek()!, REMINDER)
  const [visited, queued, trip] = asked
  // The same watch as the trip's, and only a device, a subscription and a watch besides
  expect(visited.watch).toEqual(trip.watch)
  expect(visited.watch).toEqual(watchOf(REMINDER))
  expect(queued.watch).toEqual({ at: Math.round(visit.arriveBy / 1000 - 300) - 900, lead: 300 })
  for (const { body } of asked) {
    expect(Object.keys(JSON.parse(body!))).toEqual(["device", "subscription", "watch"])
    expect(body).not.toMatch(COURSE)
  }
  expect(states(page)).toEqual(["v1 set", "c1 set", "r1 set"])
})

test("un-going leaves the reminder: it's the phone's own, for the visit", async () => {
  const page = await tab()
  await page.remind(page.ready.peek()!, { ...REMINDER, visit: { ...meetings("MUB 330")[0], occurrence: { id: "pin1", title: "Board games" } } })
  const before = asked.length
  const social = await import("../../src/social/browser/api.mts")
  await social.setGoing("pin1", true).catch(() => {})
  await social.setGoing("pin1", false).catch(() => {})
  expect(asked.slice(before).every(({ path }) => path.startsWith("/api/pins/pin1"))).toBe(true)
  expect(asked.length).toBeGreaterThan(before)
  expect(states(await tab())).toEqual(["r1 set"])
})

test("a class reminder goes on to its next meeting once a push of the current one is shown, set with the Worker under the same id, the same push again moving it no further", async () => {
  const page = await tab()
  const visits = meetings("N343")
  const { reminder, queue } = classReminder(visits)
  await page.remind(page.ready.peek()!, reminder, queue)
  const sw = await serviceWorker()
  const due = pushOf({ v: WAKE_VERSION, reminder: "c1", kind: "due", seen: { time: reminder.start, band: 0, isLive: false, status: "coming" }, at: NOW - 5 })
  await sw.push(due)
  await sw.push(due)
  const puts = asked.filter(({ method }) => method === "PUT")
  expect(puts.map(({ path }) => path)).toEqual(["/api/reminders/c1", "/api/reminders/c1"])
  expect(puts[1].watch).toEqual({ at: Math.round(visits[1].arriveBy / 1000 - 300) - 900, lead: 300 })
  expect(puts[1].body).not.toMatch(COURSE)
  // The same push again is of a meeting gone by, which only says to look
  expect(sw.shown).toEqual([expect.stringMatching(/^Leave in/), "Time to head out"])
  const store = await import("../../src/reminders/browser/store.mts")
  expect(await store.reminderOf("c1")).toMatchObject({ state: "set", visit: visits[1], queue: { next: visits.slice(2, 10).map(visit => ({ visit, to: locate(visit) })) } })
})

test("opening a page tops a class reminder up from the courses, and a room change replaces its queue and its visit, with the same id given to the Worker", async () => {
  const page = await tab()
  const { reminder, queue } = classReminder(meetings("N343"))
  await page.remind(page.ready.peek()!, reminder, queue)
  // Nothing's changed: nothing to tell
  await page.topUp(() => meetings("N343"), locate)
  expect(asked).toHaveLength(1)
  // The section moved rooms
  const moved = meetings("N113")
  await page.topUp(section => section === SECTION ? moved : [], locate)
  expect(asked.map(({ method, path }) => `${method} ${path}`)).toEqual(["PUT /api/reminders/c1", "PUT /api/reminders/c1"])
  const store = await import("../../src/reminders/browser/store.mts")
  const kept = await store.reminderOf("c1")
  expect(kept).toMatchObject({ state: "set", visit: moved[0] })
  expect([kept!.visit, ...kept!.queue!.next.map(({ visit }) => visit)]).toEqual(moved.slice(0, 10))
})

test("a class reminder past its meeting unheard, as with the phone off, goes on to the next still to come when the map loads", async () => {
  const page = await tab()
  const visits = meetings("N343").map((visit, i) => ({ ...visit, arriveBy: visit.arriveBy - 3 * 86_400_000 + (i > 1 ? 0 : -3600_000) }))
  const { reminder, queue } = classReminder(visits.slice(2))
  const missed = { ...reminder, ...unplanned("c1", HERE, { visit: visits[0], to: locate(visits[0])! }, 900) }
  const store = await import("../../src/reminders/browser/store.mts")
  await store.device()
  await store.keep({ ...missed, state: "set", queue: { ...queue, since: NOW - 4 * 86_400 } })
  await tab()
  // The first two queued are still behind, so it goes on to the first ahead
  const ahead = visits.slice(2).find(visit => visit.arriveBy - visit.offset > NOW * 1000)!
  expect(await store.reminderOf("c1")).toMatchObject({ visit: ahead, state: "set" })
  expect(asked.map(({ method, path }) => `${method} ${path}`)).toEqual(["PUT /api/reminders/c1"])
})
