// Reactive state helpers beyond plain values: what's remembered between visits, derived values passed on only when
// they change, and small comparisons and edits for sets and lists

import { r, watch, type DerivativeNode } from "bruh/reactive"

//#region Remembered between visits

// In localStorage where the browser allows it. Storage can throw, as in private browsing or when full, and what
// comes back may have been written by an older version of the app, so it's read as unknown
//
// What's yours of it (SYNCED in src/shared/sync.mts) is kept for you by the Worker too, with this as its cache:
// read here, offline included, written here first, each write stamped with when and by which browser, and sent up by
// sync.mts, which brings back what's newer from your other devices. Its stamps and what's still to send are one
// entry beside the values, SYNC

import { type Entries, type Key, type Stamp, SYNCED, isSynced } from "../shared/sync.mts"
import { randomBase64Url } from "../shared/base64url.mts"

/** A remembered value, or null if there's none or it can't be read */
export const stored = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null")
  }
  catch {
    return null
  }
}

export const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  }
  catch {}
}

/** The entry with what's yours: who this browser is to its stamps, each key's stamp, and the keys still to send */
const SYNC = "sync"

type Sync = { by: string, stamps: Partial<Record<Key, Stamp>>, pending: Key[] }

const isStamp = (value: unknown): value is Stamp => {
  const { at, by }: { at?: unknown, by?: unknown } = Object(value)
  return typeof at === "number" && typeof by === "string"
}

/**
 * What's kept of the syncing. A browser that kept things before it did has them sent, stamped at 0, so anything
 * written since on another device wins over them, and they reach a device that has none
 */
export const syncing = (): Sync => {
  const found: { by?: unknown, stamps?: unknown, pending?: unknown } = Object(stored(SYNC))
  if (typeof found.by === "string") {
    const stamps = Object.fromEntries(Object.entries(Object(found.stamps)).filter(([key, stamp]) => isSynced(key) && isStamp(stamp)))
    const pending = Array.isArray(found.pending) ? found.pending.filter(isSynced) : []
    return { by: found.by, stamps, pending }
  }
  const by = randomBase64Url(12)
  const kept = SYNCED.filter(key => stored(key) !== null)
  const sync: Sync = { by, stamps: Object.fromEntries(kept.map(key => [key, { at: 0, by }])), pending: kept }
  store(SYNC, sync)
  return sync
}

/** What's yours to send: each key still pending, as kept, with its stamp */
export const pendingEntries = (): Entries => {
  const { stamps, pending } = syncing()
  return Object.fromEntries(pending.flatMap(key => stamps[key] ? [[key, { ...stamps[key], value: stored(key) }]] : []))
}

/** What follows each synced key's value on this page, to show what's taken from another device */
const followers = new Map<string, Set<(value: unknown) => void>>()

/** What hears of a write of yours, to send it */
const written = new Set<() => void>()
export const onWritten = (heard: () => void) => {
  written.add(heard)
  return () => written.delete(heard)
}

/** Takes values newer than this browser's, as the Worker had them from your other devices, with their stamps */
export const take = (entries: Entries, pending: readonly Key[]) => {
  const sync = syncing()
  for (const [key, entry] of Object.entries(entries) as [Key, NonNullable<Entries[Key]>][]) {
    store(key, entry.value)
    sync.stamps[key] = { at: entry.at, by: entry.by }
    for (const follow of followers.get(key) ?? [])
      follow(entry.value)
  }
  store(SYNC, { ...sync, pending })
}

/** Stamps a write of this browser's to a key that's yours, to be sent */
const stampWrite = (key: Key) => {
  const sync = syncing()
  // Never earlier than what it replaces, so a clock set back can't lose a write to an older one
  const at = Math.max(Date.now(), (sync.stamps[key]?.at ?? 0) + 1)
  store(SYNC, { ...sync, stamps: { ...sync.stamps, [key]: { at, by: sync.by } }, pending: [...new Set([...sync.pending, key])] })
  for (const heard of written)
    heard()
}

/**
 * A value remembered between visits under a key. Stored values go through read, since they may be anything, and
 * values to store go through write when they aren't JSON as they are. One that's yours is stamped as it's written,
 * not as it's first read, and follows what's taken from your other devices
 */
export const remembered = <T,>(key: string, read: (stored: unknown) => T, write: (value: T) => unknown = value => value) => {
  const value = r(read(stored(key)))
  let isFirst = true
  watch([value], () => {
    const json = write(value.value)
    const isChange = !isFirst && JSON.stringify(json) !== JSON.stringify(stored(key))
    isFirst = false
    store(key, json)
    if (isChange && isSynced(key))
      stampWrite(key)
  })
  // What's taken is kept as this page reads it, so reading it isn't a write of its own
  if (isSynced(key)) {
    const follow = (taken: unknown) => {
      const next = read(taken)
      store(key, write(next))
      value.value = next
    }
    followers.set(key, (followers.get(key) ?? new Set()).add(follow))
  }
  return value
}

//#endregion

/** Takes what stops something that's been started, as a page's state collects to stop all it started at once */
export type Own = (stop: () => void) => void

/**
 * A derived value that reaches what depends on it only when it changes by isEqual, which bruh 2.0.0-beta.5's own
 * derived values don't manage; drop this once they do. It follows f a microtask late, as effects run
 */
export const distinct = <T,>(f: () => T, isEqual: (a: T, b: T) => boolean = Object.is): DerivativeNode<T> => {
  const value = r(f(), { isEqual })
  watch(() => {
    value.value = f()
  })
  return value
}

export const isSameList = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, i) => item === b[i])

export const isSameSet = <T,>(a: ReadonlySet<T>, b: ReadonlySet<T>) =>
  a.size === b.size && [...a].every(item => b.has(item))

/** The set with an item added if it wasn't there, or taken out if it was */
export const toggled = <T,>(set: ReadonlySet<T>, item: T) => {
  const next = new Set(set)
  if (!next.delete(item))
    next.add(item)
  return next
}
