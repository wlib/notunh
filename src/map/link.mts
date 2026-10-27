// The page the map's sheet shows over the home as a link of its own that can be shared and reopened: a section, an
// instructor, a room, a course, a place, an event, parking near a place, a parking area, a program, a stop, a bus,
// directions, a new event, you, and the buses. A page is a path under /map/, its kind then what it's of:
// /map/section/202610/12496, /map/person/<id>, /map/room/Kingsbury+N343, /map/course/CS+518, /map/place/Kingsbury+Hall,
// /map/event/<id>, /map/parking/Kingsbury+Hall or /map/parking for anywhere, /map/area/B, /map/program/<slug> or
// /map/program for the list, /map/stop/<id>, /map/bus/<id>, /map/new/<place> or /map/new, /map/directions, /map/you
// and /map/buses. Each value is one segment, its spaces as + and anything else a path can't hold escaped. What
// changes on a page in place stays a query: a program's course in focus, ?course=CS+518, and parking's stay and what
// it's for, ?arrive=2026-10-27T06:30&leave=2026-10-27T08:30&for=class on Durham's clock, never ?to=, which plans a
// trip from the home. Read by the map (state/page.mts) and by the Worker, which previews a link to one
// (worker/preview.mts). No DOM

import { parseKey } from "../courses/saved.mts"
import type { Purpose, Stay } from "../parking/model.mts"
import { atClock, hhmm, localDay } from "../shared/time.mts"

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

/** The kinds of page a path names */
const KINDS: readonly string[] = ["section", "person", "room", "course", "place", "event", "parking", "area", "program", "stop", "bus", "new", "directions", "you", "buses"] satisfies Page["kind"][]

const PURPOSES: readonly string[] = ["class", "errand", "event", "visit"] satisfies Purpose[]

/** An instant as a link and a datetime-local field hold it, on Durham's clock: "2026-10-27T06:30" */
export const fieldOf = (ms: number) =>
  `${localDay(ms)}T${hhmm(ms)}`

/** An instant from a link or a datetime-local field, or none for anything else */
export const fromField = (field: string | null) =>
  field && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(field) ? atClock(field.slice(0, 10), field.slice(11)) : undefined

/** A value as a path's segment: its spaces as +, a colon as it is, and anything else a segment can't hold escaped */
export const segmentOf = (value: string) =>
  encodeURIComponent(value).replaceAll("%20", "+").replaceAll("%3A", ":")

/** A segment's value, trimmed, or none for one that's empty or escaped wrongly */
const valueOf = (segment: string | undefined) => {
  try {
    return segment ? decodeURIComponent(segment.replaceAll("+", " ")).trim() || undefined : undefined
  }
  catch {
    return undefined
  }
}

/** The stay and purpose a query asks parking for, each left out where it's missing or makes no sense */
const parkingOf = (query: URLSearchParams): Parking => {
  const [from, to] = [fromField(query.get("arrive")), fromField(query.get("leave"))]
  const purpose = query.get("for")
  return {
    ...from !== undefined && to !== undefined && from < to && { stay: { from, to } },
    ...purpose && PURPOSES.includes(purpose) && { purpose: purpose as Purpose }
  }
}

/** The page a path names, with its query for what changes in place, or none for the map's own or anything else */
export const pageOf = (pathname: string, search = ""): Page | undefined => {
  const [kind, ...segments] = pathname.replace(/^\/map\//, "").split("/")
  if (!pathname.startsWith("/map/") || !KINDS.includes(kind) || segments.length > (kind === "section" ? 2 : 1))
    return
  const query = new URLSearchParams(search)
  const value = valueOf(segments[0])
  if (kind === "section") {
    const key = parseKey(`${segments[0]}:${segments[1]}`)
    return key && { kind, ...key }
  }
  // Parking near nowhere in particular is parking anywhere, ranked without a walk
  if (kind === "parking")
    return { kind, ...value && { place: value }, ...parkingOf(query) }
  // A program's page, with the course it's focused on; no program is the list of them, for a course those naming it
  if (kind === "program") {
    const course = query.get("course")?.trim()
    return { kind, ...value && { slug: value }, ...course && { course } }
  }
  // A new event, at a place where one's named
  if (kind === "new")
    return { kind, ...value && { place: value } }
  if (kind === "directions" || kind === "you" || kind === "buses")
    return segments.length ? undefined : { kind }
  if (!value)
    return
  return (
    kind === "room"   ? { kind, where: value } :
    kind === "course" ? { kind, code: value } :
    kind === "place"  ? { kind, name: value } :
    kind === "area"   ? { kind, id: value, ...parkingOf(query) } :
                        { kind: kind as "person" | "event" | "stop" | "bus", id: value }
  )
}

/** A page's link, or the map's for none */
export const urlOf = (page?: Page) => {
  if (!page)
    return "/map/"
  const value =
    page.kind === "section" ? `${page.term}/${page.crn}` :
    page.kind === "room"    ? segmentOf(page.where) :
    page.kind === "course"  ? segmentOf(page.code) :
    page.kind === "place"   ? segmentOf(page.name) :
    page.kind === "parking" || page.kind === "new" ? page.place && segmentOf(page.place) :
    page.kind === "program" ? page.slug && segmentOf(page.slug) :
    page.kind === "directions" || page.kind === "you" || page.kind === "buses" ? undefined :
                              segmentOf(page.id)
  const query = new URLSearchParams()
  if (page.kind === "program" && page.course)
    query.set("course", page.course)
  if ((page.kind === "parking" || page.kind === "area") && page.stay) {
    query.set("arrive", fieldOf(page.stay.from))
    query.set("leave", fieldOf(page.stay.to))
  }
  if ((page.kind === "parking" || page.kind === "area") && page.purpose)
    query.set("for", page.purpose)
  const search = query.toString().replaceAll("%3A", ":")
  return `/map/${page.kind}${value ? `/${value}` : ""}${search ? `?${search}` : ""}`
}
/** A page's link without what changes in place: parking's stay and purpose, which their fields set, and a program's course in focus */
export const viewOf = (page?: Page) =>
  !page ? urlOf() : urlOf(page.kind === "program" ? { ...page, course: undefined } : { ...page, stay: undefined, purpose: undefined } as Page)

/** Whether two pages show the same thing, whatever parking's are asked for or a program's focused on, which change in place */
export const isSameView = (a?: Page, b?: Page) =>
  a === b || (a !== undefined && b !== undefined && viewOf(a) === viewOf(b))

