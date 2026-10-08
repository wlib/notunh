// One fake page for every test of what runs in one: a document whose visibility changes, a window that says when
// it's back from the back-forward cache, a reload to watch for, localStorage in a Map, and timers and the clock
// faked, so a page's modules can be imported afresh at any moment

import { vi } from "vitest"

/** Stubs a page's globals as loaded at a time, before its modules are imported, which this makes import afresh */
export const fakePage = ({ at, visibilityState = "visible", saved = {} }: {
  at:               number,
  visibilityState?: DocumentVisibilityState,
  /** What localStorage holds, by key, as it's stored */
  saved?:           Record<string, string>
}) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  vi.setSystemTime(at)
  const page = Object.assign(new EventTarget(), { visibilityState })
  const window = new EventTarget()
  const reload = vi.fn()
  const storage = new Map(Object.entries(saved))
  vi.stubGlobal("document", page)
  vi.stubGlobal("addEventListener", window.addEventListener.bind(window))
  vi.stubGlobal("location", { reload })
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value)
  })
  vi.resetModules()
  return {
    reload,
    storage,
    setVisibility: (state: DocumentVisibilityState) => {
      page.visibilityState = state
      page.dispatchEvent(new Event("visibilitychange"))
    },
    /** Back from the back-forward cache with only pageshow to say so */
    restore: () => {
      page.visibilityState = "visible"
      window.dispatchEvent(new Event("pageshow"))
    }
  }
}

/** Real timers and globals again, for afterEach */
export const leavePage = () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
}
