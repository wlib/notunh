import { test, expect } from "vitest"
import fc from "fast-check"
import { type PushScope, type Store, startPush } from "../../src/sw/push.mts"
import { type Wake, KINDS, WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import type { Kept } from "../../src/reminders/reminder.mts"

const NOW = 1_790_000_000
const KEPT: Kept = { id: "r1", trip: "t", route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 900, expected: NOW + 900, walk: 240, lead: 600, to: "MUB", arrival: NOW + 1500, state: "set" }

/** A service worker scope with its notifications, windows, and kept reminders in memory, and what came of it all */
const world = ({ kept = new Map<string, Kept>([[KEPT.id, KEPT]]), isStoreBroken = false, windows = [] as string[] } = {}) => {
  const listeners = new Map<string, (event: never) => void>()
  const shown: { title: string, options: NotificationOptions, isOpen: boolean }[] = []
  const opened: string[] = []
  const focused: string[] = []
  const scope: PushScope = {
    addEventListener: (type: string, listener: (event: never) => void) => void listeners.set(type, listener),
    registration: {
      showNotification: async (title, options) => void shown.push({ title, options, isOpen: true }),
      getNotifications: async ({ tag } = {}) =>
        shown.filter(notification => notification.isOpen && notification.options.tag === tag).map(notification => ({
          tag: notification.options.tag!,
          close: () => notification.isOpen = false
        }))
    },
    clients: {
      matchAll: async () => windows.map(url => ({ url, focus: async () => void focused.push(url) })),
      openWindow: async url => void opened.push(url)
    },
    location: { origin: "https://notunh.app" }
  } as PushScope
  const store: Store = {
    reminderOf: async id => {
      if (isStoreBroken)
        throw new Error("The cache is gone")
      return kept.get(id)
    },
    keep: async reminder => {
      if (isStoreBroken)
        throw new Error("The cache is gone")
      kept.set(reminder.id, reminder)
    }
  }
  startPush(scope, store, () => NOW)
  /** Dispatches an event and waits for what it waits on */
  const dispatch = async (type: string, event: object) => {
    const waits: Promise<unknown>[] = []
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as never)
    await Promise.all(waits)
  }
  const push = (data: unknown) =>
    dispatch("push", { data: data === undefined ? null : { json: () => typeof data === "string" ? JSON.parse(data) : data } })
  return { shown, opened, focused, kept, push, dispatch }
}

const wake = fc.record({
  v:        fc.constant(WAKE_VERSION),
  reminder: fc.constantFrom("r1", "r2"),
  kind:     fc.constantFrom(...KINDS),
  seen:     fc.record({ time: fc.integer({ min: NOW - 600, max: NOW + 3600 }), band: fc.integer({ min: 30, max: 600 }), isLive: fc.boolean(), status: fc.constantFrom("coming" as const, "cancelled" as const, "lost" as const, "passed" as const) }),
  at:       fc.integer({ min: NOW - 600, max: NOW })
}) satisfies fc.Arbitrary<Wake>

/** A push of a shape this worker doesn't know: an earlier one without a version, or a later version */
const foreign = fc.oneof(wake.map(({ v, ...rest }) => rest), wake.map(wake => ({ ...wake, v: 2 })), wake.map(wake => ({ ...wake, extra: true, v: 3 })))

test("every push shows exactly one notification, whatever it carries and whatever the phone still keeps", async () => {
  await fc.assert(fc.asyncProperty(
    fc.oneof(wake.map(pushOf), foreign.map(push => JSON.stringify(push)), fc.constant(undefined), fc.anything(), fc.constant("{\"reminder\":\"r1\"}")),
    fc.boolean(),
    async (data, isStoreBroken) => {
      const { shown, push } = world({ isStoreBroken })
      await push(data)
      expect(shown).toHaveLength(1)
      expect(shown[0].title.length).toBeGreaterThan(0)
    }
  ))
})

test("a reminder's notification is worded on the phone from what the Worker foretold, and replaces the reminder's last one", async () => {
  const { shown, push } = world()
  await push(pushOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW }))
  expect(shown[0].title).toBe("Leave in 9 min")
  expect(shown[0].options.body).toContain("You'll be at MUB")
  expect(shown[0].options).toMatchObject({ tag: "reminder-r1" })
  await push(pushOf({ v: WAKE_VERSION, reminder: "r1", kind: "over", seen: { time: NOW + 900, band: 120, isLive: false, status: "cancelled" }, at: NOW }))
  expect(shown.map(({ isOpen }) => isOpen)).toEqual([false, true])
  expect(shown[1].title).toBe("Bus 3 may not be coming")
})

test("a push of a shape this worker doesn't know shows a plain notification, and a push older than the last shown shows the last again", async () => {
  const foreign = world()
  await foreign.push(JSON.stringify({ reminder: "r1", kind: "due", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW }))
  expect(foreign.shown.map(({ title }) => title)).toEqual(["Time to head out"])
  const { shown, kept, push } = world()
  const newer: Wake = { v: WAKE_VERSION, reminder: "r1", kind: "update", seen: { time: NOW + 1200, band: 120, isLive: true, status: "coming" }, at: NOW - 60 }
  await push(pushOf(newer))
  await push(pushOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW - 120 }))
  expect(shown.map(({ title, isOpen }) => `${title} ${isOpen ? "open" : "closed"}`)).toEqual(["Bus 3 is now due at 10:33 AM closed", "Bus 3 is now due at 10:33 AM open"])
  expect(kept.get("r1")?.last).toEqual(newer)
})

test("tapping a notification brings up an open map as it is, or opens one", async () => {
  const open = world({ windows: ["https://notunh.app/dining/", "https://notunh.app/map/?from=x"] })
  const notification = { tag: "reminder-r1", close: () => {} }
  await open.dispatch("notificationclick", { notification })
  expect(open.focused).toEqual(["https://notunh.app/map/?from=x"])
  expect(open.opened).toEqual([])
  const closed = world()
  await closed.dispatch("notificationclick", { notification })
  expect(closed.opened).toEqual(["https://notunh.app/map/"])
})
