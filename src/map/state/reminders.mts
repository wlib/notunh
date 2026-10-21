// Reminders as the page has them: setting one, which subscribes to pushes and asks the Worker to watch the run,
// cancelling one, and what's kept (src/reminders/browser/store.mts), which is what's shown. The phone and the Worker
// are kept agreeing by keeping first and telling after: a reminder is kept as setting until the Worker takes it, and
// as cancelling until the Worker hears, and whatever the Worker hasn't heard is asked again when the map loads or the
// phone comes back online. iOS asks for permission only straight from a tap, so the service worker and the Worker's
// key are made ready beforehand, and the tap subscribes at once
// (https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)

import { r } from "bruh/reactive"
import { type Kept, type Reminder, firstRide, watchOf } from "../../reminders/reminder.mts"
import { SHIFT } from "../../reminders/watch.mts"
import * as api from "../../reminders/browser/api.mts"
import * as store from "../../reminders/browser/store.mts"

/** Whether this browser can be reminded: by push, once notunh is on the Home Screen, as iOS pushes only to web apps there (https://webkit.org/blog/13878/), or not at all */
export const support = (): "push" | "install" | "none" => {
  if (!("serviceWorker" in navigator))
    return "none"
  if ("PushManager" in window && "Notification" in window)
    return "push"
  // Safari outside a Home Screen app has no PushManager, and only it says whether it's standalone
  return "standalone" in navigator ? "install" : "none"
}

/** What a tap needs at hand to subscribe at once: the service worker, and the Worker's public key */
export type Ready = { registration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer> }

/** Ready for a tap, once it is, or never where reminders aren't set up */
export const ready = r<Ready | undefined>()
let preparing: Promise<unknown> | undefined

/** Readies a tap, once, trying again on the next call if the Worker couldn't be asked */
export const prepare = () =>
  preparing ??= Promise.all([navigator.serviceWorker.ready, api.key()]).then(
    ([registration, key]) => ready.value = { registration, key },
    error => {
      console.info("Reminders aren't offered", error)
      preparing = undefined
    }
  )

/** The reminders kept on this phone, by id */
export const kept = r<ReadonlyMap<string, Kept>>(new Map())
/** s after its leave time a reminder is kept */
const KEPT = 2 * 3600

const show = (reminders: readonly Kept[]) =>
  kept.value = new Map(reminders.map(reminder => [reminder.id, reminder]))

const subscription = async () =>
  (await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null))?.toJSON()

/** Whether pushes can still reach this phone: notifications allowed, and the subscription still there */
const isSubscribed = async () =>
  window.Notification?.permission !== "denied" && await subscription() !== undefined

/** Tells the Worker what a kept reminder is waiting on, and keeps its answer, but for a refusal, which is the caller's to make good */
const tell = async (reminder: Kept, device: store.Device, subscribed: PushSubscriptionJSON | undefined) => {
  if (reminder.state === "setting" && subscribed) {
    const answer = await api.set(device, reminder.id, { subscription: subscribed, watch: watchOf(reminder) })
    // One the Worker took that can't be kept as set stays setting, and is set again with the same id later
    if (answer.kind === "done")
      await store.transition(reminder.id, "setting", "set").then(show, () => {})
    return answer
  }
  if (reminder.state === "cancelling" && (await api.cancel(device, reminder.id)).kind === "done")
    show(await store.forget(reminder.id))
}

/**
 * Shows what's kept, less reminders of buses long gone, and catches the Worker up on what it hasn't heard. A device
 * the Worker may still know, which pushes no longer reach, is forgotten on both sides
 */
const catchUp = async () => {
  const now = Date.now() / 1000
  for (const { id, start } of await store.reminders())
    if (start < now - KEPT)
      await store.forget(id)
  show(await store.reminders())
  const device = await store.deviceKept()
  if (!device)
    return
  if (!await isSubscribed()) {
    await api.forget(device)
    show(await store.forgetAll())
    return
  }
  const subscribed = await subscription()
  for (const reminder of kept.peek().values())
    if (reminder.state !== "set" && (await tell(reminder, device, subscribed))?.kind === "refused")
      show(await store.forget(reminder.id))
}

let loaded: Promise<void> | undefined
export const loadKept = () =>
  loaded ??= catchUp().catch(error => console.warn("The reminders kept here couldn't be read", error))

window.addEventListener("online", () => {
  if (loaded)
    void catchUp().catch(() => {})
})

/**
 * Sets a reminder, given what's ready, which a tap's handler must call straight away for iOS to ask for permission:
 * kept here as setting first, then set with the Worker. Rejects only for one that can't be kept or the Worker refuses
 */
export const remind = async ({ registration, key }: Ready, reminder: Reminder) => {
  const subscribed = (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })).toJSON()
  const device = await store.device()
  const setting: Kept = { ...reminder, state: "setting" }
  show(await store.keep(setting))
  const answer = await tell(setting, device, subscribed)
  if (answer?.kind === "refused") {
    show(await store.forget(reminder.id))
    throw new Error(`The reminder wasn't set: ${answer.why}`)
  }
}

/** The first bus of a reminder, as what makes a replan a different trip to the Worker */
const busOf = (reminder: Reminder) => {
  const ride = firstRide(reminder)
  return ride && `${ride.trip}@${ride.scheduled}`
}

/**
 * Whether a kept trip is still to be planned again: one yet to be left for, by a time yet to come, that the phone
 * hasn't been told of. Told, the trip is under way, or past, and a plan from here would be for another trip
 */
export const isAhead = ({ start, by, last, state }: Kept, now: number) =>
  state !== "cancelling" && last === undefined && start > now && (by === undefined || by > now)

/**
 * Plans each kept trip still ahead again, as given, and where its leave time has moved by SHIFT or its first bus has
 * changed, keeps the fresh plan under the same id and tells the Worker, which takes it as a replace. One the Worker
 * hasn't taken yet is told of as it is. One it refuses is kept as it was, as the Worker still holds that watch
 */
export const replan = async (again: (kept: Kept) => Reminder | undefined) => {
  const device = await store.deviceKept()
  if (!device)
    return
  const subscribed = await subscription()
  const now = Date.now() / 1000
  for (const reminder of kept.peek().values()) {
    if (!isAhead(reminder, now))
      continue
    const fresh = again(reminder)
    if (!fresh || (Math.abs(fresh.start - reminder.start) < SHIFT && busOf(fresh) === busOf(reminder)))
      continue
    const setting: Kept = { ...fresh, id: reminder.id, state: "setting" }
    show(await store.keep(setting))
    if ((await tell(setting, device, subscribed))?.kind === "refused")
      show(await store.keep(reminder))
  }
}

/** Cancels a reminder: kept here as cancelling first, then cancelled with the Worker */
export const cancel = async (id: string) => {
  const reminder = kept.peek().get(id)
  if (!reminder)
    return
  const cancelling: Kept = { ...reminder, state: "cancelling" }
  show(await store.keep(cancelling))
  await tell(cancelling, await store.device(), undefined)
}
