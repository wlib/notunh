// The page's reminders (src/map/state/reminders.mts) against a Worker and a browser of their own: each tab is the
// module loaded afresh over the same storage, the Worker answers as told, and the service worker's push handler
// (src/sw/push.mts) reads the same storage

import { test, expect, vi, beforeEach, afterEach } from "vitest"
import { flush } from "bruh/reactive"
import type { Reminder } from "../../src/reminders/reminder.mts"
import { WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import { type PushScope, startPush } from "../../src/sw/push.mts"
import { browserStorage } from "./browser.mts"

// Now, as the page drops reminders of buses long gone
const NOW = Math.floor(Date.now() / 1000)
const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
const REMINDER: Reminder = { id: "r1", trip: "t", route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 900, expected: NOW + 900, walk: 240, lead: 600, to: "MUB", arrival: NOW + 1500 }

type Tab = typeof import("../../src/map/state/reminders.mts")
type Asked = { method: string, path: string, device?: string, secret?: string }

let storage: ReturnType<typeof browserStorage>
/** What the Worker was asked, and how it answers: taking everything, unreachable, or refusing */
let asked: Asked[]
let worker: "up" | "down" | "refusing"
/** Something to do once the Worker has answered, before the page hears */
let answered: (() => void) | undefined
let online: (() => void)[]
let isSubscribed: boolean

beforeEach(() => {
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
    const body = init.body ? JSON.parse(init.body as string) as { device: string } : undefined
    asked.push({ method: init.method!, path: url.pathname + url.search, device: body?.device, secret: new Headers(init.headers).get("authorization") ?? undefined })
    if (worker === "down")
      throw new TypeError("Failed to fetch")
    answered?.()
    return new Response(worker === "refusing" ? "Too far ahead" : null, { status: worker === "refusing" ? 400 : 204 })
  })
})

afterEach(() => vi.unstubAllGlobals())

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

/** A service worker over the same storage, and the notifications it's shown */
const serviceWorker = async () => {
  const store = await import("../../src/reminders/browser/store.mts")
  const shown: string[] = []
  let onPush: ((event: { data: { json(): unknown }, waitUntil(promise: Promise<unknown>): void }) => void) | undefined
  const scope = {
    addEventListener: (type: string, listener: unknown) => void (type === "push" && (onPush = listener as typeof onPush)),
    registration: { showNotification: async (title: string) => void shown.push(title), getNotifications: async () => [] },
    clients: { matchAll: async () => [], openWindow: async () => {} },
    location: { origin: "https://notunh.app" }
  } as unknown as PushScope
  startPush(scope, store, () => NOW)
  return {
    shown,
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

test("a reminder the Worker refuses is dropped, with why, and one it can't be told of is kept as setting until it can", async () => {
  const page = await tab()
  worker = "refusing"
  await expect(page.remind(page.ready.peek()!, REMINDER)).rejects.toThrow("400 Too far ahead")
  expect(states(page)).toEqual([])
  worker = "down"
  await page.remind(page.ready.peek()!, REMINDER)
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

test("a device pushes no longer reach is forgotten on both sides when the map loads, reminders and all", async () => {
  const page = await tab()
  await page.remind(page.ready.peek()!, REMINDER)
  isSubscribed = false
  const later = await tab()
  expect(states(later)).toEqual([])
  expect(asked.at(-1)).toMatchObject({ method: "DELETE", path: `/api/push/devices/${asked[0].device}` })
  const store = await import("../../src/reminders/browser/store.mts")
  expect(await store.deviceKept()).toBeUndefined()
})
