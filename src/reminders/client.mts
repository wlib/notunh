// Setting a reminder from a page: subscribing to pushes, asking the Worker to watch the stop, and keeping the
// reminder whole on the phone (store.mts). iOS asks for permission only straight from a tap, so the service worker
// and the Worker's key are made ready beforehand, and the tap subscribes at once
// (https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)

import { r } from "bruh/reactive"
import * as v from "valibot"
import type { Reminder } from "./reminder.mts"
import type { Watch } from "./watch.mts"
import { type Device, device, deviceKept, forget, forgetDevice, keep, reminders } from "./store.mts"
import { getJson } from "../shared/json.mts"

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

export const prepare = () =>
  preparing ??= Promise.all([navigator.serviceWorker.ready, getJson("/api/push/key", { schema: v.object({ key: v.string() }) })]).then(
    ([registration, { key }]) => ready.value = { registration, key: Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)) },
    error => console.info("Reminders aren't offered", error)
  )

/** The reminders kept on this phone, of buses not long gone, by id */
export const kept = r<ReadonlyMap<string, Reminder>>(new Map())
const KEPT = 2 * 3600

let loaded: Promise<void> | undefined
export const loadKept = () =>
  loaded ??= reminders().catch(() => [] as Reminder[]).then(async all => {
    const now = Date.now() / 1000
    for (const { id } of all.filter(({ expected }) => expected < now - KEPT))
      void forget(id)
    kept.value = new Map(all.filter(({ expected }) => expected >= now - KEPT).map(reminder => [reminder.id, reminder]))
    // A device the Worker may still know, which pushes no longer reach, is forgotten on both sides
    const known = await deviceKept()
    if (known && !await isSubscribed())
      await unsubscribe(known)
  })

/** Whether pushes can still reach this phone: notifications allowed, and the subscription still there */
const isSubscribed = async () =>
  window.Notification?.permission !== "denied" &&
  (await (await navigator.serviceWorker.ready).pushManager.getSubscription().catch(() => null)) !== null

/** Pushes being off, the Worker forgets the device, its reminders with it, and so does the phone, which makes a new one next time */
const unsubscribe = async ({ id, secret }: Device) => {
  await fetch(`/api/push/devices/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } })
    .catch(error => console.warn("The Worker couldn't be told to forget this device", error))
  for (const id of kept.value.keys())
    await forget(id)
  await forgetDevice()
  kept.value = new Map()
}

/** Sets a reminder, given what's ready, which a tap's handler must call straight away for iOS to ask for permission */
export const remind = async ({ registration, key }: Ready, reminder: Reminder, watch: Watch) => {
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const { id, secret } = await device()
  const response = await fetch(`/api/reminders/${encodeURIComponent(reminder.id)}`, {
    method:  "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body:    JSON.stringify({ device: id, subscription: subscription.toJSON(), watch })
  })
  if (!response.ok)
    throw new Error(`The reminder wasn't set: ${response.status} ${await response.text()}`)
  await keep(reminder)
  kept.value = new Map([...kept.value, [reminder.id, reminder]])
}

/** Cancels a reminder, here even if the Worker can't be told, which then ends its watch when the window passes */
export const cancel = async (id: string) => {
  const { id: deviceId, secret } = await device()
  await fetch(`/api/reminders/${encodeURIComponent(id)}?device=${encodeURIComponent(deviceId)}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } })
    .catch(error => console.warn("The Worker couldn't be told of a cancelled reminder", error))
  await forget(id)
  kept.value = new Map([...kept.value].filter(([kept]) => kept !== id))
}
