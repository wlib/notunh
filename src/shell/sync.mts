// Your things, kept for you by the Worker as well as here (src/shared/sync.mts, docs/storage.md): every page sends
// what's been written here since it last asked, and takes what's newer from your other devices, as it loads, a
// moment after each write, on coming back online, and on coming back to the page. As this device, by the id and
// secret it keeps (src/reminders/browser/store.mts); where storage lost them, they're taken back from the cookie the
// Worker keeps them in, and a device that has neither and nothing to send makes nothing, so a visit that saves
// nothing leaves nothing on the Worker. Offline, or with the Worker down, everything is still read and written here,
// and sent the next time

import * as v from "valibot"
import { Entries, stillPending, toTake } from "../shared/sync.mts"
import { device, deviceKept, recovered } from "../reminders/browser/store.mts"
import { onWritten, pendingEntries, syncing, take } from "./state.mts"

/** ms after a write before it's sent, so a few in a row go together */
const SETTLE_MS = 1000

const Answer = v.object({ entries: Entries })

/** This device as the Worker knows it, kept or taken back from its cookie, else made if there's anything to send */
const asDevice = async (isSending: boolean) =>
  isSending ? device() : await deviceKept() ?? await recovered()

/** One exchange with the Worker, never two at once */
let running: Promise<void> | undefined
let isAgain = false

const exchange = async () => {
  const sent = pendingEntries()
  const self = await asDevice(Object.keys(sent).length > 0).catch(() => undefined)
  if (!self)
    return
  const response = await fetch("/api/state", {
    method:  "POST",
    headers: { authorization: `Bearer ${self.secret}`, "content-type": "application/json" },
    body:    JSON.stringify({ device: self.id, entries: sent })
  })
  if (!response.ok)
    return
  const answer: unknown = await response.json()
  if (!v.is(Answer, answer))
    return
  // What's been written meanwhile stays to send, and isn't written over
  const { stamps, pending } = syncing()
  const still = stillPending(pending, sent, stamps)
  take(toTake(stamps, answer.entries, still), still)
}

/** Sends what's to send and takes what's newer, once now, and again after if asked meanwhile */
export const sync = (): Promise<void> => {
  if (running) {
    isAgain = true
    return running
  }
  running = exchange().catch(() => {}).finally(() => {
    running = undefined
    if (isAgain) {
      isAgain = false
      void sync()
    }
  })
  return running
}

let settling: ReturnType<typeof setTimeout> | undefined

/** Starts keeping your things with the Worker, for as long as the page is open */
export const startSync = () => {
  onWritten(() => {
    clearTimeout(settling)
    settling = setTimeout(sync, SETTLE_MS)
  })
  addEventListener("online", () => void sync())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible")
      void sync()
  })
  // An installed app is kept from storage pressure where the browser grants it, as WebKit does Home Screen apps; a
  // tab isn't asked, as Firefox would ask its user
  if (matchMedia("(display-mode: standalone)").matches)
    void navigator.storage?.persist?.().catch(() => {})
  void sync()
}
