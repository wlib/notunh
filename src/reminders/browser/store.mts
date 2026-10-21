// What the phone keeps of its reminders: this device's id and secret for the Worker, and each reminder whole with
// where it stands. One JSON entry in Cache Storage, which pages and the service worker share and localStorage isn't,
// in a cache of its own apart from the app's (src/sw/worker.mts). Every change is read, edited and written under one
// Web Lock, so two tabs setting their first reminder at once get one device and lose nothing. Storage can fail, as
// in private browsing or when full: a read that fails is empty, and a write that fails rejects

import * as v from "valibot"
import { Kept } from "../reminder.mts"
import { randomBase64Url } from "../../shared/base64url.mts"

/** The cache the reminders are kept in, which the app's service worker leaves alone */
export const CACHE = "reminders-v1"
const ENTRY = "/reminders.json"
const LOCK = "notunh-reminders"

export const Device = v.object({ id: v.string(), secret: v.string() })
export type Device = v.InferOutput<typeof Device>

/** Everything kept, as one document, whose version is bumped with any change of meaning: another's reads as empty */
const Doc = v.object({ version: v.literal(1), device: v.optional(Device), reminders: v.array(Kept) })
type Doc = v.InferOutput<typeof Doc>

const empty = (): Doc =>
  ({ version: 1, reminders: [] })

const read = async (): Promise<Doc> => {
  try {
    const doc: unknown = await (await (await caches.open(CACHE)).match(ENTRY))?.json()
    return v.is(Doc, doc) ? doc : empty()
  }
  catch {
    return empty()
  }
}

const write = async (doc: Doc) =>
  (await caches.open(CACHE)).put(ENTRY, new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }))

/** Edits what's kept, one tab or worker at a time, and gives back the reminders as they are then */
const change = <T,>(edit: (doc: Doc) => T): Promise<T> =>
  navigator.locks.request(LOCK, async () => {
    const doc = await read()
    const result = edit(doc)
    await write(doc)
    return result
  })

/** A reminder kept here, if it is */
export const reminderOf = async (id: string) =>
  (await read()).reminders.find(reminder => reminder.id === id)

export const reminders = async () =>
  (await read()).reminders

/** Keeps a reminder as it stands, in place of what was kept of it */
export const keep = (kept: Kept) =>
  change(doc => doc.reminders = [...doc.reminders.filter(({ id }) => id !== kept.id), kept])

export const forget = (id: string) =>
  change(doc => doc.reminders = doc.reminders.filter(reminder => reminder.id !== id))

/** This device's id and secret, if it has had any */
export const deviceKept = async () =>
  (await read()).device

/** This device's id and secret, made the first time any tab asks */
export const device = () =>
  change(doc => doc.device ??= { id: randomBase64Url(16), secret: randomBase64Url(32) })

/** Drops the device and every reminder, as when pushes no longer reach the phone */
export const forgetAll = () =>
  change(doc => {
    delete doc.device
    return doc.reminders = []
  })
