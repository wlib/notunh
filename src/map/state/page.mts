// The page the map's sheet shows over the home, at its link (src/map/link.mts). Opening one adds to the browser's
// history, so Back goes back through what was opened, to the search it was opened from, or to the map from a page
// this visit didn't open, scrolled as it was left. Each page says what it's called, for the Back that returns to it,
// and the place it's at, which the map shows. Reactive values only, no DOM

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
  /** How far down the page shown is scrolled, as the sheet says */
  const scrolled = r(0)
  /** Where the sheet scrolls the page just shown to: the top of one opened, or where one returned to was left */
  const scrollTo = r({ top: 0 })

  const depth = () => entry().depth ?? 0
  /**
   * How far down each page in the history was as it was last left, by depth. Back and Forward only reach a page that's
   * been left since it opened, so one opened over another's place in the history never reads what that one left
   */
  const scrolls: number[] = []
  /** The depth of the page shown, as history.state has already moved on by the time Back or Forward says so */
  let shownDepth = depth()

  /**
   * Marks where a page is, or that it's nowhere, only while that page is the one shown. A view taken off the sheet can
   * still run its reactive parts until it's collected, as a tick of the clock re-runs them, and must never move the
   * map from the page shown
   */
  const focusAt = (of: Page, at?: Omit<Focus, "view">) => {
    if (isSameView(of, page.peek()))
      focus.value = at && { ...at, view: viewOf(of) }
  }

  /** Shows a page, and for one opened or returned to, where to scroll it to, keeping where the one shown was left */
  const show = (next: Page | undefined, top?: number) => {
    if (!isSameView(next, page.peek())) {
      name.value = undefined
      focus.value = undefined
    }
    backTo.value = entry().back ?? "Map"
    if (top !== undefined) {
      scrolls[shownDepth] = scrolled.peek()
      shownDepth = depth()
      scrollTo.value = { top }
    }
    page.value = next
  }

  /** Shows a page, or the map for none, as a new entry in the history, opened from the page shown, or the search open */
  const go = (next?: Page) => {
    const search = next && searching.peek()
    const back = search ? "Search" : page.peek() ? name.peek() ?? "Back" : "Map"
    history.pushState({ depth: depth() + 1, back, ...search && { search } } satisfies Entry, "", urlOf(next))
    show(next, 0)
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
      show(undefined, 0)
    }
    if (search !== undefined)
      resumed.value = search
  }

  const following = new AbortController()
  addEventListener("popstate", () => show(pageOf(globalThis.location.pathname, globalThis.location.search), scrolls[depth()] ?? 0), { signal: following.signal })
  own(() => following.abort())

  return { page, name, focus, focusAt, backTo, searching, resumed, scrolled, scrollTo, go, amend, back }
}
