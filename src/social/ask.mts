// The one push the social layer sends: when the host sets a time, each device that marked it is asked "Going?",
// worded by the Worker, as the phone has nothing of the event. Tapping it opens the event's page as Going, which is
// the answer in one tap; the page says so and the button takes it back. Everyone else gets nothing

import * as v from "valibot"
import { type Pin, pinPath } from "./event.mts"
import { TIME_ZONE } from "../shared/time.mts"

const ASK_VERSION = 1

/** What's pushed: the event's id, and the words to show */
export const Ask = v.object({ v: v.literal(ASK_VERSION), ask: v.string(), title: v.string(), body: v.string() })
export type Ask = v.InferOutput<typeof Ask>

const clock = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", hour: "numeric", minute: "2-digit" })

/** The ask for an event set at its time, like "Set for Thu 4:00 PM · Going?" over "Tennis, anyone? · Field House" */
export const askOf = (pin: Pick<Pin, "id" | "title" | "start" | "place" | "where">): Ask =>
  ({ v: ASK_VERSION, ask: pin.id, title: `Set for ${clock.format(pin.start)} · Going?`, body: [pin.title, pin.place ?? pin.where].filter(Boolean).join(" · ") })

/** The tag an ask is shown under, one an event, so a second replaces the first */
export const askTag = (id: string) =>
  `ask-${id}`

/** The event's id an ask's tag is of, or none for a notification that isn't an ask */
export const askedId = (tag: string) =>
  tag.startsWith("ask-") ? tag.slice(4) : undefined

/** Where tapping an ask opens: the event's page, which says Going for this device as it opens */
export const askUrl = (origin: string, id: string) =>
  `${origin}${pinPath(id)}#going`

/** What showing an ask uses of the service worker's registration, so tests can hand it one of their own */
export type Shower = {
  showNotification(title: string, options: { body: string, tag: string, icon: string }): Promise<void>,
  getNotifications(filter?: { tag?: string }): Promise<{ close(): void }[]>
}

/**
 * Shows an ask in the service worker, closing the event's earlier one first, as Safari ignores tag. Wired into the
 * service worker's push handler for a push that is an Ask, and its click handler opens askUrl for a tag askedId reads
 */
export const showAsk = async (registration: Shower, ask: Ask, icon: string) => {
  const tag = askTag(ask.ask)
  for (const notification of await registration.getNotifications({ tag }).catch(() => []))
    notification.close()
  await registration.showNotification(ask.title, { body: ask.body, tag, icon })
}
