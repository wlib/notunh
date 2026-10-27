// The page the map's sheet shows over the home, at its link (src/map/link.mts). Opening one adds to the browser's
// history, so Back goes back through what was opened, to the search it was opened from, or to the map from a page
// this visit didn't open. Each page says what it's called, for the Back that returns to it, and the place it's at,
// which the map shows. Reactive values only, no DOM

import { r } from "bruh/reactive"
import type { Place } from "../../places/search.mts"
import type { Own } from "../../shell/state.mts"
import { type Page, isSameView, pageOf, urlOf, viewOf } from "../link.mts"

/** Where a page is on the map, and its marker's label there, "Kingsbury Hall · 2:10 PM", with the page's view it's of */
export type Focus = { place: Place, label: string, view: string }

/**
 * What a page's entry in the history keeps: how many pages deep this visit has gone, so Back only goes back through
 * its own, what Back returns to, by name, and the search it was opened from, to return to with what was typed
 */
type Entry = { depth: number, back: string, search?: string }

const entry = (): Partial<Entry> =>
  Object(history.state)

/** The page shown, from the address the map opened at, following Back and Forward. own is given what stops it */
export const createPage = (own: Own) => {
  const page = r(pageOf(globalThis.location.pathname, globalThis.location.search))
  /** What the page shown is called, as its Back says it, and where it is, which the map marks, as the page says them */
  const name = r<string>()
  const focus = r<Focus>()
  /** What Back returns to, by name: "Map", "Search", or the page before */
  const backTo = r(entry().back ?? "Map")
  /** What's typed in search while it's open, so a page opened from its results returns to it */
  const searching = r<string>()
  /** What was typed in the search a page was opened from, once Back has returned to it, for search to take up again */
  const resumed = r<string>()

  const depth = () => entry().depth ?? 0

  /**
   * Marks where a page is, or that it's nowhere, only while that page is the one shown. A view taken off the sheet can
   * still run its reactive parts until it's collected, as a tick of the clock re-runs them, and must never move the
   * map from the page shown
   */
  const focusAt = (of: Page, at?: Omit<Focus, "view">) => {
    if (isSameView(of, page.peek()))
      focus.value = at && { ...at, view: viewOf(of) }
  }

  const show = (next: Page | undefined) => {
    if (!isSameView(next, page.peek())) {
      name.value = undefined
      focus.value = undefined
    }
    backTo.value = entry().back ?? "Map"
    page.value = next
  }

  /** Shows a page, or the map for none, as a new entry in the history, opened from the page shown, or the search open */
  const go = (next?: Page) => {
    const search = next && searching.peek()
    const back = search ? "Search" : page.peek() ? name.peek() ?? "Back" : "Map"
    history.pushState({ depth: depth() + 1, back, ...search && { search } } satisfies Entry, "", urlOf(next))
    show(next)
  }

  /** Changes the page shown in place, its link with it, as parking's fields do, without an entry in the history */
  const amend = (next?: Page) => {
    history.replaceState(history.state, "", urlOf(next))
    show(next)
  }

  /** Back to what was shown before, the search it was opened from with what was typed, or to the map from a page this visit opened at */
  const back = () => {
    const { search } = entry()
    if (depth() > 0)
      history.back()
    else {
      history.replaceState(null, "", urlOf())
      show(undefined)
    }
    if (search !== undefined)
      resumed.value = search
  }

  const following = new AbortController()
  addEventListener("popstate", () => show(pageOf(globalThis.location.pathname, globalThis.location.search)), { signal: following.signal })
  own(() => following.abort())

  return { page, name, focus, focusAt, backTo, searching, resumed, go, amend, back }
}
