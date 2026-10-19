// One fake page for every test of what runs in one: a document whose visibility changes, with a head naming its
// data, a window that says when it's back from the back-forward cache, a reload to watch for, localStorage in a
// Map, and timers and the clock faked, so a page's modules can be imported afresh at any moment

import { vi } from "vitest"

export const RELEASE = "2026-10-18T08:00:00.000Z"

/** A page's head, as the build writes it, with its release, its code, and the data files it names */
export const headOf = (data: Record<string, string>, code = ["/assets/index-AAAAAAAA.js"], release = RELEASE) =>
  `<head><meta name="release" content="${release}">${code.map(src => `<script type="module" crossorigin src="${src}"></script>`).join("")}` +
  `${Object.entries(data).map(([name, href]) => `<link rel="preload" as="fetch" crossorigin="anonymous" href="${href}" data-name="${name}">`).join("")}</head>`

/** Stubs a page's globals as loaded at a time, before its modules are imported, which this makes import afresh */
export const fakePage = ({ at, visibilityState = "visible", saved = {}, data = {}, code }: {
  at:               number,
  visibilityState?: DocumentVisibilityState,
  /** What localStorage holds, by key, as it's stored */
  saved?:           Record<string, string>,
  /** The data files the page's head names, by name, and its code */
  data?:            Record<string, string>,
  code?:            string[]
}) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  vi.setSystemTime(at)
  const page = Object.assign(new EventTarget(), { visibilityState, head: { outerHTML: headOf(data, code) } })
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
