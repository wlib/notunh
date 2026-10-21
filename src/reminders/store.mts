// What the phone keeps of its reminders, in IndexedDB, which pages and the service worker share and localStorage
// isn't: this device's id and secret for the Worker, and each reminder whole

import * as v from "valibot"
import { Reminder } from "./reminder.mts"

const NAME = "notunh-reminders"
const REMINDERS = "reminders"
const DEVICE = "device"

export const Device = v.object({ id: v.string(), secret: v.string() })
export type Device = v.InferOutput<typeof Device>

const done = <T,>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

let opened: Promise<IDBDatabase> | undefined
const open = () => {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(REMINDERS, { keyPath: "id" })
      request.result.createObjectStore(DEVICE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  // A failed open is tried afresh next time
  opened.catch(() => opened = undefined)
  return opened
}

const store = async (name: string, mode: IDBTransactionMode) =>
  (await open()).transaction(name, mode).objectStore(name)

/** A reminder kept here, if it is and still reads as one */
export const reminderOf = async (id: string) => {
  const kept = await done((await store(REMINDERS, "readonly")).get(id))
  return v.is(Reminder, kept) ? kept : undefined
}

export const reminders = async () =>
  (await done((await store(REMINDERS, "readonly")).getAll())).filter(kept => v.is(Reminder, kept))

export const keep = async (reminder: Reminder) =>
  void await done((await store(REMINDERS, "readwrite")).put(reminder))

export const forget = async (id: string) =>
  void await done((await store(REMINDERS, "readwrite")).delete(id))

/** This device's id and secret, made the first time they're asked for */
export const device = async (): Promise<Device> => {
  const kept = await done((await store(DEVICE, "readonly")).get(DEVICE))
  if (v.is(Device, kept))
    return kept
  const made = { id: randomId(), secret: randomId() + randomId() }
  await done((await store(DEVICE, "readwrite")).put(made, DEVICE))
  return made
}

/** 128 random bits, base64url */
export const randomId = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
