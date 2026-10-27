// What the phone keeps of its reminders: this device's id and secret for the Worker, and each reminder whole with
// where it stands. One JSON entry in Cache Storage, which pages and the service worker share and localStorage isn't,
// in a cache of its own apart from the app's (src/sw/worker.mts). Every change is read, edited and written under one
// Web Lock, so two tabs setting their first reminder at once get one device and lose nothing. Storage can fail, as
// in private browsing or when full: a read or write that fails rejects, and nothing is written over what's kept

import * as v from "valibot"
import { Kept, type State } from "../reminder.mts"
import { randomBase64Url } from "../../shared/base64url.mts"

/** The cache the reminders are kept in, which the app's service worker leaves alone */
export const CACHE = "reminders-v1"
const ENTRY = "/reminders.json"
const LOCK = "notunh-reminders"

export const Device = v.object({ id: v.string(), secret: v.string() })
export type Device = v.InferOutput<typeof Device>

/**
 * Everything kept, as one document, whose version is bumped with any change of meaning: another's reads as empty,
 * but for the device, which the Worker still knows by its secret, so its watches go on and are forgotten with it. 3
 * adds a reminder's visit and a class's queue (queue.mts), so 2's read as 3's without them; 2 keeps each reminder as
 * its whole trip (reminder.mts); 1 kept the first bus alone
 */
const Doc = v.object({ version: v.literal(3), device: v.optional(Device), reminders: v.array(Kept) })
type Doc = v.InferOutput<typeof Doc>
const Two = v.object({ ...Doc.entries, version: v.literal(2) })
const Other = v.object({ device: v.optional(Device) })

const empty = (device?: Device): Doc =>
  ({ version: 3, ...device && { device }, reminders: [] })

/** What's kept, or empty where nothing is or it's of another version, its device kept. Rejects where storage can't be read, so nothing is written over what it may still hold */
const read = async (): Promise<Doc> => {
  // Opening the cache would make it, so a page that only looks, as every page does for its device, leaves none behind
  const doc: unknown = await caches.has(CACHE) ? await (await (await caches.open(CACHE)).match(ENTRY))?.json() : undefined
  return (
    v.is(Doc, doc) ? doc :
    v.is(Two, doc) ? { ...doc, version: 3 } :
                     empty(v.is(Other, doc) ? doc.device : undefined)
  )
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

/**
 * Edits a reminder kept here, as moving a class's on to its next visit (src/reminders/queue.mts) does
 * @returns the reminder as edited, or nothing where it isn't kept or the edit left it as it was
 */
export const amend = (id: string, edit: (kept: Kept) => Kept) =>
  change(doc => {
    const kept = doc.reminders.find(reminder => reminder.id === id)
    if (!kept)
      return
    const edited = edit(kept)
    if (edited === kept)
      return
    doc.reminders = doc.reminders.map(reminder => reminder === kept ? edited : reminder)
    return edited
  })

export const forget = (id: string) =>
  change(doc => doc.reminders = doc.reminders.filter(reminder => reminder.id !== id))

/** This device's id and secret, if it has had any */
export const deviceKept = async () =>
  (await read()).device

/**
 * This device's id and secret as the Worker's cookie keeps them (worker/session.mts), taken back where storage lost
 * them; one kept meanwhile, as by another tab, stays. None where there's no cookie, or no Worker to ask
 */
export const recovered = async () => {
  const session: unknown = await fetch("/api/session").then(response => response.ok ? response.json() : undefined).catch(() => undefined)
  return v.is(Session, session) ? change(doc => doc.device ??= { id: session.device, secret: session.secret }) : undefined
}

const Session = v.object({ device: v.string(), secret: v.string() })

/** This device's id and secret: as kept, else as the Worker's cookie keeps them, else made, the first time any tab asks */
export const device = async () =>
  await deviceKept() ?? await recovered() ?? change(doc => doc.device ??= { id: randomBase64Url(16), secret: randomBase64Url(32) })

/**
 * Drops every reminder, as when pushes no longer reach the phone. The device's id and secret stay, as pins and votes
 * are made as the same device (src/social/browser/api.mts), and a reminder set later sets the Worker's secret anew
 */
export const forgetAll = () =>
  change(doc => doc.reminders = [])

/**
 * Moves a reminder from one state to another, only if it's still in the first: one taken by the Worker is set only
 * while it's still setting, so a cancel meanwhile isn't written over
 * @returns the reminders as they are then
 */
export const transition = (id: string, from: State, to: State) =>
  change(doc => {
    const reminder = doc.reminders.find(reminder => reminder.id === id)
    if (reminder?.state === from)
      reminder.state = to
    return doc.reminders
  })
