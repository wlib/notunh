// The page the map's sheet shows over the home, each at a link of its own that can be shared and reopened: a section,
// an instructor, a room, a course, a place, an event, parking near a place, a parking area, a program, a stop, a bus,
// directions, a new event, you, and the buses. A page is one query parameter on /map/, as ?to= already is, never a
// hash: /map/?section=202610:12496, ?person=, ?room=Kingsbury+N343, ?course=CS+518, ?place=Kingsbury+Hall, ?event=,
// ?parking=Kingsbury+Hall, ?area=B, ?program=computer-science-minor, which may name a course to focus on,
// &course=CS+518, or none, the list, ?stop=<id>, ?bus=<id>, ?directions, ?new=<place or nothing>, ?you and ?buses,
// with ?pin=, as links to events were first made, read as ?event=. Parking's two carry the stay and what it's for
// besides, as &arrive=2026-10-27T06:30&leave=2026-10-27T08:30&for=class on Durham's clock, never &to=, which plans a
// trip. Opening one adds to the browser's history, so Back goes back through what was opened, to the search it was
// opened from, or to the map from a page this visit didn't open, scrolled as it was left. Each page says what it's
// called, for the Back that returns to it, and the place it's at, which the map shows. Reactive values only, no DOM

import { r } from "bruh/reactive"
import { parseKey } from "../../courses/saved.mts"
import type { Purpose, Stay } from "../../parking/model.mts"
import type { Place } from "../../places/search.mts"
import { atClock, hhmm, localDay } from "../../shared/time.mts"
import type { Own } from "../../shell/state.mts"

export type Page =
  | { kind: "section", term: string, crn: string }
  | { kind: "person", id: string }
  | { kind: "room", where: string }
  | { kind: "course", code: string }
  | { kind: "place", name: string }
  | { kind: "event", id: string }
  | { kind: "parking", place?: string } & Parking
  | { kind: "area", id: string } & Parking
  | { kind: "program", slug?: string, course?: string }
  | { kind: "stop", id: string }
  | { kind: "bus", id: string }
  | { kind: "new", place?: string }
  | { kind: "directions" }
  | { kind: "you" }
  | { kind: "buses" }

/** What parking's pages are asked for besides: the stay, and what it's for, else now and for a visit */
export type Parking = { stay?: Stay, purpose?: Purpose }

/** The query parameter each kind of page is, in the order a link naming more than one is read */
const PARAMS = ["section", "person", "room", "program", "course", "place", "event", "parking", "area", "stop", "bus", "new", "directions", "you", "buses"] as const

/** The pages that are what they are with no value: the page is the parameter's being there */
const BARE = ["directions", "you", "buses"] as const

/** Parameters read as another, as links made before it was named so are */
const ALIASES: Record<string, typeof PARAMS[number]> = { pin: "event" }

/** Where a page is on the map, and its marker's label there, "Kingsbury Hall · 2:10 PM", with the page's view it's of */
export type Focus = { place: Place, label: string, view: string }

const PURPOSES: readonly string[] = ["class", "errand", "event", "visit"] satisfies Purpose[]

/** An instant as a link and a datetime-local field hold it, on Durham's clock: "2026-10-27T06:30" */
export const fieldOf = (ms: number) =>
  `${localDay(ms)}T${hhmm(ms)}`

/** An instant from a link or a datetime-local field, or none for anything else */
export const fromField = (field: string | null) =>
  field && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(field) ? atClock(field.slice(0, 10), field.slice(11)) : undefined

/** The stay and purpose a query asks parking for, each left out where it's missing or makes no sense */
const parkingOf = (query: URLSearchParams): Parking => {
  const [from, to] = [fromField(query.get("arrive")), fromField(query.get("leave"))]
  const purpose = query.get("for")
  return {
    ...from !== undefined && to !== undefined && from < to && { stay: { from, to } },
    ...purpose && PURPOSES.includes(purpose) && { purpose: purpose as Purpose }
  }
}

/** The page a query names, or none: the first parameter it has of PARAMS, read as that page */
export const pageOf = (search: string): Page | undefined => {
  const query = new URLSearchParams(search)
  for (const [alias, param] of Object.entries(ALIASES))
    if (query.has(alias) && !query.has(param))
      query.set(param, query.get(alias)!)
  for (const param of PARAMS) {
    const value = query.get(param)?.trim()
    const key = param === "section" && value ? parseKey(value) : undefined
    // Parking near nowhere in particular is parking anywhere, ranked without a walk
    if (param === "parking" && query.has(param))
      return { kind: "parking", ...value && { place: value }, ...parkingOf(query) }
    // A program's page, with the course it's focused on; no program is the list of them, for a course those naming it
    if (param === "program" && query.has(param)) {
      const course = query.get("course")?.trim()
      return { kind: "program", ...value && { slug: value }, ...course && { course } }
    }
    // A new event, at a place where one's named
    if (param === "new" && query.has(param))
      return { kind: "new", ...value && { place: value } }
    if ((BARE as readonly string[]).includes(param) && query.has(param))
      return { kind: param as typeof BARE[number] }
    if (!value || (param === "section" && !key))
      continue
    return (
      key                                    ? { kind: "section", ...key } :
      param === "person" || param === "event" || param === "stop" || param === "bus" ? { kind: param, id: value } :
      param === "room"                       ? { kind: "room", where: value } :
      param === "course"                     ? { kind: "course", code: value } :
      param === "area"                       ? { kind: "area", id: value, ...parkingOf(query) } :
                                               { kind: "place", name: value }
    )
  }
}

/** A page's link, or the map's for none. The section's colon is left as it is, as a term and CRN read */
export const urlOf = (page?: Page) => {
  if (!page)
    return "/map/"
  const [param, value] =
    page.kind === "section" ? ["section", `${page.term}:${page.crn}`] :
    page.kind === "room"    ? ["room", page.where] :
    page.kind === "course"  ? ["course", page.code] :
    page.kind === "place"   ? ["place", page.name] :
    page.kind === "parking" ? ["parking", page.place ?? ""] :
    page.kind === "program" ? ["program", page.slug ?? ""] :
    page.kind === "new"     ? ["new", page.place ?? ""] :
    page.kind === "directions" || page.kind === "you" || page.kind === "buses" ? [page.kind, ""] :
                              [page.kind, page.id]
  const query = new URLSearchParams({ [param]: value })
  if (page.kind === "program" && page.course)
    query.set("course", page.course)
  if ((page.kind === "parking" || page.kind === "area") && page.stay) {
    query.set("arrive", fieldOf(page.stay.from))
    query.set("leave", fieldOf(page.stay.to))
  }
  if ((page.kind === "parking" || page.kind === "area") && page.purpose)
    query.set("for", page.purpose)
  // A bare page's parameter stands alone, "?you", as its value says nothing
  return `/map/?${query.toString().replaceAll("%3A", ":").replace(/^(directions|you|buses)=$/, "$1")}`
}

/** A page's link without what changes in place: parking's stay and purpose, which their fields set, and a program's course in focus */
export const viewOf = (page?: Page) =>
  !page ? urlOf() : urlOf(page.kind === "program" ? { ...page, course: undefined } : { ...page, stay: undefined, purpose: undefined } as Page)

/** Whether two pages show the same thing, whatever parking's are asked for or a program's focused on, which change in place */
export const isSameView = (a?: Page, b?: Page) =>
  a === b || (a !== undefined && b !== undefined && viewOf(a) === viewOf(b))

/**
 * What a page's entry in the history keeps: how many pages deep this visit has gone, so Back only goes back through
 * its own, what Back returns to, by name, and the search it was opened from, to return to with what was typed
 */
type Entry = { depth: number, back: string, search?: string }

const entry = (): Partial<Entry> =>
  Object(history.state)

/** The page shown, from the address the map opened at, following Back and Forward. own is given what stops it */
export const createPage = (own: Own) => {
  const page = r(pageOf(globalThis.location.search))
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
  addEventListener("popstate", () => show(pageOf(globalThis.location.search), scrolls[depth()] ?? 0), { signal: following.signal })
  own(() => following.abort())

  return { page, name, focus, focusAt, backTo, searching, resumed, scrolled, scrollTo, go, amend, back }
}
