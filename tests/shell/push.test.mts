import { test, expect } from "vitest"
import fc from "fast-check"
import { type PushScope, type Store, startPush } from "../../src/sw/push.mts"
import { type Wake, KINDS, WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import type { Kept } from "../../src/reminders/reminder.mts"

const NOW = 1_790_000_000
const KEPT: Kept = {
  id: "r1", from: { lat: 43.13, lon: -70.93, name: "Here" }, to: { lat: 43.14, lon: -70.94, name: "MUB" }, way: "w",
  legs: [{ kind: "walk", walk: 240, to: "Kingsbury Hall" }, { kind: "ride", trip: "t", route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 900, expected: NOW + 900, isLive: true }, { kind: "walk", walk: 120, to: "MUB" }],
  start: NOW + 600, end: NOW + 1500, headsUp: 300, state: "set"
}

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
  expect(shown[0].options.body).toContain("MUB 10:38 AM")
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
  expect(shown.map(({ title, isOpen }) => `${title} ${isOpen ? "open" : "closed"}`)).toEqual(["Bus 3 now 10:33 AM closed", "Bus 3 now 10:33 AM open"])
  expect(kept.get("r1")?.last).toEqual(newer)
})

test("tapping a notification brings up an open map as it is, or opens one on the reminder's trip", async () => {
  const open = world({ windows: ["https://notunh.app/dining/", "https://notunh.app/map/?from=x"] })
  const notification = { tag: "reminder-r1", close: () => {} }
  await open.dispatch("notificationclick", { notification })
  expect(open.focused).toEqual(["https://notunh.app/map/?from=x"])
  expect(open.opened).toEqual([])
  const closed = world()
  await closed.dispatch("notificationclick", { notification })
  expect(closed.opened).toEqual(["https://notunh.app/map/?reminder=r1"])
})

test("a push for a walk-only reminder, one with a change past its margin, and one with a `by` are each worded on the phone, terse, and replace the reminder's last notification", async () => {
  const walked: Kept = { ...KEPT, id: "r1", legs: [{ kind: "walk", walk: 840, to: "MUB" }], start: NOW + 300, end: NOW + 1140 }
  const change: Kept = {
    ...KEPT, id: "r2",
    legs: [KEPT.legs[0], KEPT.legs[1], { kind: "ride", trip: "t2", route: "4", stop: "102", routeName: "4", stopName: "Main St", scheduled: NOW + 1500, expected: NOW + 1500, isLive: false }, KEPT.legs[2]],
    end: NOW + 2400, margin: 240
  }
  const byTime: Kept = { ...KEPT, id: "r3", by: NOW + 1800, margin: 300 }
  const { shown, push } = world({ kept: new Map([walked, change, byTime].map(kept => [kept.id, kept])) })
  const due = (reminder: string, time: number, band: number) =>
    push(pushOf({ v: WAKE_VERSION, reminder, kind: "due", seen: { time, band, isLive: true, status: "coming" }, at: NOW }))
  await due("r1", NOW + 300, 0)
  await due("r2", NOW + 900 + 300, 60)
  await due("r3", NOW + 900, 60)
  expect(shown.map(({ title, options }) => `${title} | ${options.body}`)).toEqual([
    "Leave in 5 min | 14 min walk to MUB, there 10:32 AM.",
    "Leave in 15 min | Bus 3 at Kingsbury Hall 10:33 AM (5 min late) · 4 min walk · may miss the 10:38 AM change · Open notunh for another way to MUB.",
    "Leave in 10 min | Bus 3 at Kingsbury Hall 10:28 AM · 4 min walk · MUB 10:38 AM, before your 10:43 AM"
  ])
  for (const { options: { body } } of shown)
    expect(body!.length).toBeLessThan(160)
  // Each is the reminder's own, and a later push of one replaces it
  expect(shown.map(({ options }) => options.tag)).toEqual(["reminder-r1", "reminder-r2", "reminder-r3"])
  await due("r2", NOW + 900 + 240, 60)
  expect(shown.map(({ isOpen }) => isOpen)).toEqual([true, false, true, true])
  expect(shown[3].options.body).toBe("Bus 3 at Kingsbury Hall 10:32 AM (4 min late) · 4 min walk · MUB 10:57 AM")
})
