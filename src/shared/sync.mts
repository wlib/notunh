// Your things kept for you as a person, beside each device's own copy: saved sections, saved trips, your permit,
// your laundry rooms and your dining hall and filters. Each is one key, whose last write wins, by when it was made
// and then by which device made it, so every device and the Worker settle on the same value whatever order they hear
// of writes in. The Worker decides, by isNewer, and each device keeps what it answers but for what it's written
// since it asked. Pure: the pages keep and send (src/shell/state.mts, src/shell/sync.mts), the Worker stores
// (worker/social.mts)

import * as v from "valibot"

/** The keys kept for you, each a page's own localStorage key, and nothing else is taken */
export const SYNCED = [
  "courses-saved",
  "map-goals",
  "parking-permit",
  "laundry-favorites",
  "dining-hall",
  "dining-diets",
  "dining-avoid"
] as const

export type Key = typeof SYNCED[number]

export const isSynced = (key: string): key is Key =>
  (SYNCED as readonly string[]).includes(key)

/** The most a key's value may be, as JSON */
export const MAX_BYTES = 8192

/** When a write was made, in epoch ms, and by which device, which breaks a tie */
export type Stamp = { at: number, by: string }

/** A key's value as written, and its stamp */
export type Entry = Stamp & { value: unknown }

export type Entries = Partial<Record<Key, Entry>>

/** Whether a write is newer than another, or than none: later, or as late and by a device that sorts after */
export const isNewer = (a: Stamp, b: Stamp | undefined) =>
  !b || a.at > b.at || (a.at === b.at && a.by > b.by)

/** Two sets of entries as one, the newer of each key's */
export const merged = (a: Entries, b: Entries): Entries => {
  const out: Entries = { ...a }
  for (const key of SYNCED) {
    const entry = b[key]
    if (entry && isNewer(entry, out[key]))
      out[key] = entry
  }
  return out
}

/**
 * The entries the Worker answers that a device takes: every one it isn't still to send, whose stamp isn't what the
 * device has. What the Worker keeps is what every device settles on, its own writes included, as the Worker never
 * stamps a write later than its own clock
 */
export const toTake = (stamps: Partial<Record<Key, Stamp>>, remote: Entries, pending: readonly Key[]): Entries =>
  Object.fromEntries(SYNCED.flatMap(key => {
    const entry = remote[key]
    const own = stamps[key]
    return entry && !pending.includes(key) && (entry.at !== own?.at || entry.by !== own.by) ? [[key, entry]] : []
  }))

/**
 * What's still to send once the Worker has taken what was sent: the keys written again since, whose stamps are no
 * longer what went
 */
export const stillPending = (pending: readonly Key[], sent: Entries, stamps: Partial<Record<Key, Stamp>>): Key[] =>
  pending.filter(key => {
    const went = sent[key]
    const now = stamps[key]
    return !went || !now || went.at !== now.at || went.by !== now.by
  })

const Stamped = {
  at: v.pipe(v.number(), v.integer(), v.minValue(0)),
  by: v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/))
}

/** An entry as sent: a stamp, and any JSON value no longer than MAX_BYTES */
export const Entry = v.object({
  ...Stamped,
  value: v.pipe(v.unknown(), v.check(value => value !== undefined && JSON.stringify(value).length <= MAX_BYTES, `A value is at most ${MAX_BYTES} bytes`))
})

/** Entries as sent: only keys kept for you */
export const Entries = v.pipe(
  v.record(v.string(), Entry),
  v.check(entries => Object.keys(entries).every(isSynced), "Only keys kept for you"),
  v.transform(entries => entries as Entries)
)
