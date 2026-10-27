// Telling the Worker of what's kept, which pages and the service worker both do: a reminder kept as setting is set
// under its id, and kept as set once the Worker's taken it, only if it's still setting then. And a class reminder
// moved on to its next visit (src/reminders/queue.mts), kept first under the lock and told after, as everything is

import { type Kept, watchOf } from "../reminder.mts"
import type { Wake } from "../watch.mts"
import { movedOn } from "../queue.mts"
import * as api from "./api.mts"
import * as store from "./store.mts"

/**
 * Sets a kept reminder's watch with the Worker. One it took that can't be kept as set stays setting, and is set
 * again with the same id later
 * @returns the Worker's answer, a refusal the caller's to make good, and the reminders as kept after, if they changed
 */
export const setKept = async (kept: Kept, device: store.Device, subscription: PushSubscriptionJSON) => {
  const answer = await api.set(device, kept.id, { subscription, watch: watchOf(kept) })
  const reminders = answer.kind === "done" ? await store.transition(kept.id, "setting", "set").catch(() => undefined) : undefined
  return { answer, reminders }
}

/**
 * Moves a class reminder on from the visit it's for, as of epoch seconds `now`, once a push of it came (`wake`) or
 * it's done with, and sets the next with the Worker under the same id, where there's a subscription to set it with
 * @returns the reminder as moved on, or nothing where it didn't move
 */
export const moveOn = async (id: string, now: number, subscription: PushSubscriptionJSON | undefined, wake?: Wake) => {
  const moved = await store.amend(id, kept => movedOn(kept, now, wake))
  const device = moved && await store.deviceKept()
  if (moved && device && subscription)
    await setKept(moved, device, subscription)
  return moved
}
