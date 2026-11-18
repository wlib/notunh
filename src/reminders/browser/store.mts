// What the phone keeps of its reminders: this device's id and secret for the Worker, and each reminder whole with
// where it stands. One JSON entry in Cache Storage, which pages and the service worker share and localStorage isn't,
// in a cache of its own apart from the app's (src/sw/worker.mts). Every change is read, edited and written under one
// Web Lock, so two tabs setting their first reminder at once get one device and lose nothing. Storage can fail, as
// in private browsing or when full: a read or write that fails rejects, and nothing is written over what's kept.
// Nor is what newer code kept, which reads as no reminders, and every change to it rejects

import * as v from "valibot"
import { Kept, type State } from "../reminder.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { format, read, versionOf } from "../../shared/format.mts"

/** The cache the reminders are kept in, which the app's service worker leaves alone */
export const CACHE = "reminders-v1"
const ENTRY = "/reminders.json"
const LOCK = "notunh-reminders"

export const Device = v.object({ id: v.string(), secret: v.string() })
export type Device = v.InferOutput<typeof Device>

/**
 * Everything kept, as one document, whose version is bumped with any change of meaning, read by its format
 * (src/shared/format.mts). 3 adds a reminder's visit and a class's queue (queue.mts), so 2's read as 3's without
 * them; 2 keeps each reminder as its whole trip (reminder.mts); 1 kept the first bus alone, and reads as empty
 */
const Doc = v.object({ version: v.literal(3), device: v.optional(Device), reminders: v.array(Kept) })
type Doc = v.InferOutput<typeof Doc>
const DocFormat = format(Doc, 3, two => ({ ...Object(two), version: 3 }))
const Other = v.object({ device: v.optional(Device) })

const empty = (device?: Device): Doc =>
  ({ version: 3, ...device && { device }, reminders: [] })

/** What's kept as it is, whatever its version. Rejects where storage can't be read, so nothing is written over what it may still hold */
const kept = async (): Promise<unknown> =>
  // Opening the cache would make it, so a page that only looks, as every page does for its device, leaves none behind
  await caches.has(CACHE) ? (await (await caches.open(CACHE)).match(ENTRY))?.json() : undefined

/**
 * What's kept as this code reads it, or empty where nothing is, it can't be read, as one of an older version than
 * still read can't, or newer code kept it. Empty but for the device, which the Worker still knows by its secret, so
 * it's still this device to everything else, and its watches go on and are forgotten with it
 */
const docOf = (kept: unknown): Doc => {
  const found = read(DocFormat, kept)
  return "value" in found ? found.value : empty(v.is(Other, kept) ? kept.device : undefined)
}

const readDoc = async () =>
  docOf(await kept())

const write = async (doc: Doc) =>
  (await caches.open(CACHE)).put(ENTRY, new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }))

/**
 * Edits what's kept, one tab or worker at a time, and gives back the reminders as they are then. Rejects where newer
 * code kept what's there, which is never written over
 */
const change = <T,>(edit: (doc: Doc) => T): Promise<T> =>
  navigator.locks.request(LOCK, async () => {
    const was = await kept()
    if (versionOf(was) > DocFormat.version)
      throw new DOMException(`The reminders kept are of version ${versionOf(was)}, newer than this reads`, "VersionError")
    const doc = docOf(was)
    const result = edit(doc)
    await write(doc)
    return result
  })

/** A reminder kept here, if it is */
export const reminderOf = async (id: string) =>
  (await readDoc()).reminders.find(reminder => reminder.id === id)

export const reminders = async () =>
  (await readDoc()).reminders

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
  (await readDoc()).device

const Session = v.object({ device: v.string(), secret: v.string() })

/**
 * What the Worker's cookie keeps, asked once a page however many ask, as everything a page loads may: a device, or
 * none where it answers nothing (204) or anything else. Asked again only where the Worker couldn't be reached
 */
let session: Promise<Device | undefined> | undefined

const sessionKept = () =>
  session ??= fetch("/api/session").then(
    async response => {
      const found: unknown = response.status === 200 ? await response.json().catch(() => undefined) : undefined
      return v.is(Session, found) ? { id: found.device, secret: found.secret } : undefined
    },
    () => session = undefined
  )

/**
 * This device's id and secret as the Worker's cookie keeps them (worker/session.mts), taken back where storage lost
 * them; one kept meanwhile, as by another tab or a device made since, stays. None where there's no cookie, or no
 * Worker to ask
 */
export const recovered = async () => {
  const found = await sessionKept()
  return found ? change(doc => doc.device ??= found) : undefined
}

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
