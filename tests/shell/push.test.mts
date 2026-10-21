import { test, expect } from "vitest"
import fc from "fast-check"
import { type Kept, type PushScope, startPush } from "../../src/sw/push.mts"
import { type Wake, KINDS, pushOf } from "../../src/reminders/watch.mts"
import type { Reminder } from "../../src/reminders/reminder.mts"

const NOW = 1_790_000_000
const KEPT: Reminder = { id: "r1", trip: "t", route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 900, expected: NOW + 900, walk: 240, lead: 600, to: "MUB", arrival: NOW + 1500 }

/** A service worker scope with its notifications, windows, and kept reminders in memory, and what came of it all */
const world = ({ kept = new Map<string, Reminder>([[KEPT.id, KEPT]]), isStoreBroken = false, windows = [] as string[] } = {}) => {
  const listeners = new Map<string, (event: never) => void>()
  const shown: { title: string, options: NotificationOptions, isOpen: boolean }[] = []
  const opened: string[] = []
  const navigated: string[] = []
  const scope: PushScope = {
    addEventListener: (type: string, listener: (event: never) => void) => void listeners.set(type, listener),
    registration: {
      showNotification: async (title, options) => void shown.push({ title, options, isOpen: true }),
      getNotifications: async ({ tag } = {}) =>
        shown.filter(notification => notification.isOpen && notification.options.tag === tag).map(notification => ({
          tag: notification.options.tag!,
          data: notification.options.data,
          close: () => notification.isOpen = false
        }))
    },
    clients: {
      matchAll: async () => windows.map(url => ({ url, focus: async () => {}, navigate: async (to: string) => void navigated.push(to) })),
      openWindow: async url => void opened.push(url)
    },
    location: { origin: "https://notunh.app" }
  } as PushScope
  const store: Kept = {
    reminderOf: async id => {
      if (isStoreBroken)
        throw new Error("IndexedDB is gone")
      return kept.get(id)
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
  return { shown, opened, navigated, push, dispatch }
}

const wake = fc.record({
  reminder: fc.constantFrom("r1", "r2"),
  kind:     fc.constantFrom(...KINDS),
  seen:     fc.record({ time: fc.integer({ min: NOW - 600, max: NOW + 3600 }), band: fc.integer({ min: 30, max: 600 }), isLive: fc.boolean(), status: fc.constantFrom("coming" as const, "cancelled" as const, "passed" as const) }),
  at:       fc.constant(NOW)
}) satisfies fc.Arbitrary<Wake>

test("every push shows exactly one notification, whatever it carries and whatever the phone still keeps", async () => {
  await fc.assert(fc.asyncProperty(
    fc.oneof(wake.map(pushOf), fc.constant(undefined), fc.anything(), fc.constant("{\"reminder\":\"r1\"}")),
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
  await push(pushOf({ reminder: "r1", kind: "due", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW }))
  expect(shown[0].title).toBe("Leave in 9 min")
  expect(shown[0].options.body).toContain("You'll be at MUB")
  expect(shown[0].options).toMatchObject({ tag: "reminder-r1", data: { url: "/map/?reminder=r1" } })
  await push(pushOf({ reminder: "r1", kind: "over", seen: { time: NOW + 900, band: 120, isLive: false, status: "cancelled" }, at: NOW }))
  expect(shown.map(({ isOpen }) => isOpen)).toEqual([false, true])
  expect(shown[1].title).toBe("Bus 3 may not be coming")
})

test("tapping a notification brings up an open map at the reminder, or opens one", async () => {
  const open = world({ windows: ["https://notunh.app/dining/", "https://notunh.app/map/"] })
  const notification = { tag: "reminder-r1", data: { url: "/map/?reminder=r1" }, close: () => {} }
  await open.dispatch("notificationclick", { notification })
  expect(open.navigated).toEqual(["https://notunh.app/map/?reminder=r1"])
  expect(open.opened).toEqual([])
  const closed = world()
  await closed.dispatch("notificationclick", { notification })
  expect(closed.opened).toEqual(["https://notunh.app/map/?reminder=r1"])
})
