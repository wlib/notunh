// Reactive state helpers beyond plain values: what's remembered between visits, derived values passed on only when
// they change, and small comparisons and edits for sets and lists

import { r, watch, type DerivativeNode } from "bruh/reactive"

//#region Remembered between visits

// In localStorage where the browser allows it. Storage can throw, as in private browsing or when full, and what
// comes back may have been written by an older version of the app, so it's read as unknown

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

/**
 * A value remembered between visits under a key. Stored values go through read, since they may be anything, and
 * values to store go through write when they aren't JSON as they are
 */
export const remembered = <T,>(key: string, read: (stored: unknown) => T, write: (value: T) => unknown = value => value) => {
  const value = r(read(stored(key)))
  watch([value], () => store(key, write(value.value)))
  return value
}

//#endregion

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
