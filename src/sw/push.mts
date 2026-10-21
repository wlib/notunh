// Reminders' pushes in the service worker. Every push shows a notification, whatever goes wrong, as iOS revokes
// permission from a site whose push shows none (https://webkit.org/blog/12945/). The phone words it from what the
// Worker saw at the stop and the reminder it keeps (src/reminders/reminder.mts), and closes the reminder's earlier
// notification first, as Safari ignores tag (https://bugs.webkit.org/show_bug.cgi?id=258922). Tapping one opens the map

import * as v from "valibot"
import { Wake } from "../reminders/watch.mts"
import { type Reminder, textOf } from "../reminders/reminder.mts"

type Extendable = { waitUntil(promise: Promise<unknown>): void }
type Shown = { tag: string, close(): void }
type PushLike = Extendable & { data: { json(): unknown } | null }
type ClickLike = Extendable & { notification: Shown }
type Window = { url: string, focus(): Promise<unknown> }

/** What the push handlers use of the service worker's global scope, so tests can hand it one of their own */
export type PushScope = {
  addEventListener(type: "push", listener: (event: PushLike) => void): void,
  addEventListener(type: "notificationclick", listener: (event: ClickLike) => void): void,
  registration: {
    showNotification(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>,
    getNotifications(filter?: { tag?: string }): Promise<Shown[]>
  },
  clients: { matchAll(options: { type: "window" }): Promise<Window[]>, openWindow(url: string): Promise<unknown> },
  location: { origin: string }
}

/** The reminders the phone keeps, src/reminders/store.mts in the service worker */
export type Kept = { reminderOf(id: string): Promise<Reminder | undefined> }

export const startPush = (scope: PushScope, kept: Kept, now = () => Date.now() / 1000) => {
  const show = async ({ data }: PushLike) => {
    const wake = v.parse(Wake, data?.json())
    const reminder = await kept.reminderOf(wake.reminder).catch(() => undefined)
    const { title, body } = textOf(wake, reminder, now())
    const tag = `reminder-${wake.reminder}`
    // Safari keeps every notification of a tag, so the one this replaces is closed first
    for (const notification of await scope.registration.getNotifications({ tag }).catch(() => []))
      notification.close()
    await scope.registration.showNotification(title, { body, tag, renotify: true, icon: "/icon-192.png" })
  }

  scope.addEventListener("push", event => {
    event.waitUntil(show(event).catch(() =>
      scope.registration.showNotification("notunh", { body: "Open notunh for your bus.", icon: "/icon-192.png" })
    ))
  })

  // An open map is brought up as it is, else one is opened
  scope.addEventListener("notificationclick", event => {
    event.notification.close()
    const target = new URL("/map/", scope.location.origin)
    event.waitUntil((async () => {
      const map = (await scope.clients.matchAll({ type: "window" })).find(window => new URL(window.url).pathname === target.pathname)
      if (map)
        await map.focus()
      else
        await scope.clients.openWindow(target.href)
    })())
  })
}
