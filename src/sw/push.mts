// Reminders' pushes in the service worker. Every push shows a notification, whatever goes wrong, as iOS revokes
// permission from a site whose push shows none (https://webkit.org/blog/12945/). The phone words it from what the
// Worker saw at the stop and the reminder it keeps (src/reminders/reminder.mts), and closes the reminder's earlier
// notification first, as Safari ignores tag (https://bugs.webkit.org/show_bug.cgi?id=258922). Tapping one opens the map.
// A class reminder goes on to its next visit once the push of its current one is shown (src/reminders/queue.mts)

import * as v from "valibot"
import { Wake } from "../reminders/watch.mts"
import { type Kept, textOf } from "../reminders/reminder.mts"
import { Ask, askUrl, askedId, showAsk } from "../social/ask.mts"

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

/** The reminders the phone keeps, src/reminders/browser/store.mts in the service worker */
export type Store = { reminderOf(id: string): Promise<Kept | undefined>, keep(kept: Kept): Promise<unknown> }

/** Moves a class reminder on from the visit a push is of, and sets the next with the Worker (src/reminders/browser/sync.mts) */
export type MoveOn = (id: string, wake: Wake) => Promise<unknown>

const ICON = "/icon-192.png"

export const startPush = (scope: PushScope, store: Store, now = () => Date.now() / 1000, moveOn?: MoveOn) => {
  const show = async ({ data }: PushLike) => {
    const json = data?.json()
    // An event set at a time asks those who marked it "Going?" (src/social/ask.mts)
    if (v.is(Ask, json)) {
      await showAsk(scope.registration, json, ICON)
      return
    }
    const pushed = v.parse(Wake, json)
    const kept = await store.reminderOf(pushed.reminder).catch(() => undefined)
    // A push from before a class reminder moved on is of a visit gone by, which only says to look
    const reminder = kept?.queue && pushed.at <= kept.queue.since ? undefined : kept
    // Pushes can arrive out of order, so one older than the last shown shows the last again, and the newest is kept
    const wake = reminder?.last && pushed.at < reminder.last.at ? reminder.last : pushed
    if (reminder && wake !== reminder.last)
      await store.keep({ ...reminder, last: wake }).catch(() => {})
    const { title, body } = textOf(wake, reminder, now())
    const tag = `reminder-${wake.reminder}`
    // Safari keeps every notification of a tag, so the one this replaces is closed first
    for (const notification of await scope.registration.getNotifications({ tag }).catch(() => []))
      notification.close()
    await scope.registration.showNotification(title, { body, tag, renotify: true, icon: ICON })
    if (reminder?.queue)
      await moveOn?.(reminder.id, pushed).catch(() => {})
  }

  // A push this worker can't read, as one of a shape it doesn't know, still shows something
  scope.addEventListener("push", event => {
    event.waitUntil(show(event).catch(() =>
      scope.registration.showNotification("Time to head out", { body: "Open notunh for your trip.", icon: ICON })
    ))
  })

  // An open map is brought up as it is, else one is opened on the reminder's trip, which it plans afresh
  scope.addEventListener("notificationclick", event => {
    event.notification.close()
    const asked = askedId(event.notification.tag)
    if (asked !== undefined) {
      event.waitUntil(scope.clients.openWindow(askUrl(scope.location.origin, asked)))
      return
    }
    const target = new URL("/map/", scope.location.origin)
    const id = event.notification.tag.replace(/^reminder-/, "")
    event.waitUntil((async () => {
      const map = (await scope.clients.matchAll({ type: "window" })).find(window => new URL(window.url).pathname === target.pathname)
      if (map)
        await map.focus()
      else
        await scope.clients.openWindow(`${target.href}?reminder=${encodeURIComponent(id)}`)
    })())
  })
}
