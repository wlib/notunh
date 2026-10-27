// The Worker's social routes (worker/social.mts), asked as this device: the same id and secret reminders use
// (src/reminders/browser/store.mts), made the first time anything is asked, so a pin, a mark, and a reminder are
// all one device's. Reads that need no device take none, so the pin page works for anyone with the link. A refusal
// is an error with the Worker's own words, which the UI shows as they are. A mark comes with the phone's push
// subscription where it can have one, so the host setting that time asks it "Going?" (src/social/ask.mts)

import * as v from "valibot"
import { Pin } from "../event.mts"
import { device, deviceKept } from "../../reminders/browser/store.mts"
import { key } from "../../reminders/browser/api.mts"
import { readJson } from "../../shared/json.mts"

const Me = v.object({ person: v.string(), verified: v.nullable(v.string()) })
const Link = v.object({ code: v.string(), expires: v.number() })
const Linked = v.object({ linked: v.boolean(), expires: v.number() })

/** A command as this device, with its secret, to a route, or an error saying what the Worker refused it for */
const command = async <T,>(method: "POST" | "DELETE", path: string, body: Record<string, unknown>, schema?: v.GenericSchema<unknown, T>): Promise<T> => {
  const { id, secret } = await device()
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body:    JSON.stringify({ device: id, ...body })
  })
  if (!response.ok)
    throw new Error(await response.text() || `${response.status}`)
  return schema ? readJson(response, schema) : undefined as T
}

/** A read as this device, if it has asked anything before, so a pin says what this device has to do with it */
const read = async <T,>(path: string, schema: v.GenericSchema<unknown, T>): Promise<T | undefined> => {
  const kept = await deviceKept().catch(() => undefined)
  const query = kept ? `${path.includes("?") ? "&" : "?"}device=${encodeURIComponent(kept.id)}` : ""
  const response = await fetch(path + query, { headers: kept ? { authorization: `Bearer ${kept.secret}` } : {} })
  return response.status === 404 ? undefined : readJson(response, schema)
}

export const pin = (id: string) =>
  read(`/api/pins/${encodeURIComponent(id)}`, Pin)

/** The public pins on a Durham day */
export const pinsOn = (day: string) =>
  read(`/api/pins?day=${day}`, v.array(Pin)).then(pins => pins ?? [])

/** An event as made: one time, or up to three to pick from */
export type NewPin = Pick<Pin, "id" | "title" | "description" | "place" | "where" | "times" | "spots" | "visibility">

export const makePin = (made: NewPin) =>
  command("POST", "/api/pins", made, Pin)

/** Going, or not, once the time is set; refused with "Full" when every spot is taken */
export const setGoing = (id: string, going: boolean) =>
  command("POST", `/api/pins/${encodeURIComponent(id)}/going`, { going }, Pin)

/** What subscribing needs, readied as the page loads, so a tap can subscribe at once, as iOS asks it to */
let pushing: { registration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer> } | undefined

export const preparePush = () =>
  "serviceWorker" in navigator && "PushManager" in window && Promise.all([navigator.serviceWorker.ready, key()])
    .then(([registration, key]) => void (pushing = { registration, key }), () => {})

/** The phone's push subscription, asking for permission the first time, or none where there can't be one */
const subscribed = () =>
  pushing && window.Notification?.permission !== "denied"
    ? pushing.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushing.key }).then(subscription => subscription.toJSON(), () => undefined)
    : Promise.resolve(undefined)

/** Marks a time as working for this device, or unmarks it; called straight from a tap, for the permission prompt */
export const mark = (id: string, time: number, marked: boolean) => {
  const subscription = marked ? subscribed() : Promise.resolve(undefined)
  return subscription.then(subscription => command("POST", `/api/pins/${encodeURIComponent(id)}/marks`, { time, marked, subscription }, Pin))
}

/** The host sets one of the times, which asks those who marked it "Going?" */
export const setTime = (id: string, time: number) =>
  command("POST", `/api/pins/${encodeURIComponent(id)}/set`, { time }, Pin)

export const deletePin = (id: string) =>
  command("DELETE", `/api/pins/${encodeURIComponent(id)}`, {})

export const report = (id: string) =>
  command("POST", `/api/pins/${encodeURIComponent(id)}/reports`, {}, v.object({ hidden: v.boolean() }))

/** Who this device is to the Worker, once it's asked anything */
export const me = () =>
  read("/api/me", Me)

/** A code for this device to show, for a device that has the identity to approve */
export const linkCode = () =>
  command("POST", "/api/link", {}, Link)

/** Whether this device's code has been approved yet */
export const linked = (code: string) =>
  read(`/api/link/${code}`, Linked)

/** Approves a code shown by another device, which joins it to this device's person */
export const approve = (code: string) =>
  command("POST", `/api/link/${encodeURIComponent(code)}`, {}, v.object({ linked: v.boolean() }))

export const sendCode = (address: string) =>
  command("POST", "/api/email", { address }, v.object({ sent: v.boolean(), expires: v.number() }))

export const verify = (address: string, code: string) =>
  command("POST", "/api/email/verify", { address, code }, v.object({ verified: v.string(), joined: v.optional(v.boolean(), false) }))
