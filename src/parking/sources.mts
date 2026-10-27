// The sources the hand-kept areas (areas.mts) are checked against each night, read into plain shapes, and the check
// itself, which also fills each area's point. Pure, so scripts/map/parking.mts fetches and the tests read fixtures:
// - UNH's pay-per-hour zone table, a PDF, read as text: every zone there is an area here with the same number, rate,
//   max, days and hours
// - ParkMobile's list of zones in a rectangle around campus, which answers without a login: every UNH zone there is
//   an area here, active, and an area's point is near ParkMobile's
// - OpenStreetMap's parking areas from the extract the map is made from: every way an area names is one, and its
//   middle is the area's point where none is given
// A problem is a sentence naming the area and both sides, and any problem fails the night

import * as v from "valibot"
import { type Coordinates, segmentMeters } from "../geo/projection.mts"
import { Area, EVERY_DAY, WEEKDAYS } from "./model.mts"
import type { Rules } from "./areas.mts"

/** Where the build keeps the parking areas, as scripts/map/parking.mts writes them */
export const PARKING = "src/parking/parking.json"

/** Where the map data keeps OpenStreetMap's parking areas, as scripts/map/osm.mts writes them each week */
export const OSM_PARKING = "src/map/parking.json"

/**
 * The parking areas as a page loads them. Each source's own time, as epoch milliseconds: when the zone table was
 * fetched, when ParkMobile answered, and the day of the OpenStreetMap extract; and when the file was built, which
 * says nothing of how fresh the rules are
 */
export const ParkingData = v.object({
  sources: v.object({ zones: v.number(), parkMobile: v.number(), osm: v.number() }),
  built:   v.number(),
  areas:   v.array(Area)
})
export type ParkingData = v.InferOutput<typeof ParkingData>

/** What parking loads as when its file can't, or a build had none: no areas, which pages say couldn't load */
export const NO_PARKING: ParkingData = { sources: { zones: 0, parkMobile: 0, osm: 0 }, built: 0, areas: [] }

/** How fresh the rules are: the oldest source's time, which is what a row should say it was checked */
export const checkedAt = ({ sources }: ParkingData) =>
  Math.min(...Object.values(sources))

/** UNH's winter parking ban page, which says which lots close on a winter night, for a person to check */
export const WINTER_PAGE = "https://www.unh.edu/transportation/parking/information/winter-parking-ban"

/** The town's parking page, for its own lots and meters, which these areas leave out */
export const TOWN_PAGE = "https://www.durhamnh.gov/605/Visitor-Parking-Information-Map"

//#region The zone table

/** The visitor page, which links the zone table, whose URL changes with each year's upload */
export const VISITOR_PAGE = "https://www.unh.edu/transportation/parking/visitor-metered-parking"

/** The zone table's URL from the visitor page's HTML */
export const zoneTableUrl = (html: string) => {
  const href = html.match(/href="([^"]*parking-meter-info[^"]*\.pdf)"/)?.[1]
  return href && new URL(href, VISITOR_PAGE).href
}

/** A literal or hex string of a content stream, as WinAnsi text, which for this table's characters is Latin-1 */
const stringOf = (token: string) =>
  token.startsWith("<")
    ? token.slice(1, -1).replace(/\s/g, "").replace(/../g, hex => String.fromCharCode(parseInt(hex, 16)))
    : token.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, code: string) =>
        /\d/.test(code) ? String.fromCharCode(parseInt(code, 8)) : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[code] ?? code)

const inflate = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer())

/**
 * A PDF's text, line by line, as its pages' content streams draw it: each run of text placed by a text matrix, runs on
 * one baseline joined left to right, lines top to bottom. Enough for a table made by Word with simple fonts, which this
 * is; a PDF that isn't gives too few lines and the check says so
 */
export const pdfLines = async (pdf: Uint8Array<ArrayBuffer>) => {
  const text = new TextDecoder("latin1").decode(pdf)
  const runs: { x: number, y: number, text: string }[] = []
  for (const [, id] of text.matchAll(/\/Contents (\d+) 0 R/g)) {
    const object = text.search(new RegExp(`(^|\\s)${id} 0 obj`))
    const dictionary = text.slice(object, text.indexOf("stream", object))
    const start = text.indexOf("stream", object) + "stream".length
    const begin = start + (text[start] === "\r" ? 2 : 1)
    const length = +(dictionary.match(/\/Length (\d+)/)?.[1] ?? text.indexOf("endstream", begin) - begin)
    const raw = pdf.subarray(begin, begin + length)
    const content = new TextDecoder("latin1").decode(dictionary.includes("FlateDecode") ? await inflate(raw) : raw)
    let at = { x: 0, y: 0 }
    let operands: string[] = []
    for (const [token] of content.matchAll(/\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)|<<|>>|<[0-9a-fA-F\s]*>|[[\]]|\/?[^\s()<>[\]/]+/gs)) {
      if (token === "Tm")
        at = { x: +operands.at(-2)!, y: +operands.at(-1)! }
      else if (token === "Td" || token === "TD")
        at = { x: at.x + +operands.at(-2)!, y: at.y + +operands.at(-1)! }
      else if (token === "Tj" || token === "TJ" || token === "'")
        runs.push({ ...at, text: operands.filter(operand => /^[(<]/.test(operand)).map(stringOf).join("") })
      if (/^[A-Za-z'"*]+$/.test(token))
        operands = []
      else
        operands.push(token)
    }
  }
  const lines = new Map<number, typeof runs>()
  for (const run of runs)
    lines.set(Math.round(run.y), [...lines.get(Math.round(run.y)) ?? [], run])
  return [...lines]
    .sort(([a], [b]) => b - a)
    .map(([, line]) => line.sort((a, b) => a.x - b.x).map(run => run.text).join(" ").replace(/\s+/g, " ").trim())
}

/** A row of the zone table, as the areas keep a zone */
export type TableZone = { name: string, number: number, rate: number, max: number, days: number[], hours: [number, number] }

// "Sage Way Visitor Lot 98717 $1.85 14 7-days 7:00 a.m. - 9:00 p.m.", with the dashes and dots as the table has them
const ZONE_LINE = /^(.+?) (98\d{3}) \$(\d+\.\d\d) (\d+) (Mon-Fri|7-days) (\d{1,2}):00 a\.m\.? ?-? ?(\d{1,2}):00 p\.m ?\.?$/

/** The zones the table's lines name */
export const zoneTable = (lines: readonly string[]): TableZone[] =>
  lines.flatMap(line => {
    const [, name, number, rate, max, days, from, to] = line.match(ZONE_LINE) ?? []
    return name ? [{ name, number: +number, rate: +rate, max: +max, days: days === "7-days" ? EVERY_DAY : WEEKDAYS, hours: [+from * 60, (+to + 12) * 60] as [number, number] }] : []
  })

//#endregion

//#region ParkMobile

/** The rectangle around campus and downtown ParkMobile is asked for, as south, west, north, east */
const RECTANGLE = { lat1: 43.125, lon1: -70.965, lat2: 43.155, lon2: -70.915 }

/** ParkMobile's zones in the rectangle, from the route its own map page asks, which needs no login */
export const PARKMOBILE = `https://app.parkmobile.io/v2/parking/api/areas/inrectangle?${new URLSearchParams(Object.entries(RECTANGLE).map(([key, value]) => [key, `${value}`]))}`

export const UNH = "University of New Hampshire"

const ParkMobileZone = v.object({
  signageAreaCode:     v.string(),
  publicInfo:          v.string(),
  parkingOperatorName: v.string(),
  status:              v.string(),
  displayPoint:        v.object({ lat: v.number(), lon: v.number() })
})
export type ParkMobileZone = v.InferOutput<typeof ParkMobileZone>

/** ParkMobile's answer: its zones, and when it answered */
export const ParkMobileList = v.pipe(
  v.object({ data: v.array(ParkMobileZone), meta: v.object({ timestamp: v.pipe(v.string(), v.isoTimestamp()) }) }),
  v.transform(({ data, meta }) => ({ zones: data, at: Date.parse(meta.timestamp) }))
)

//#endregion

//#region OpenStreetMap

const Lonlat = v.tuple([v.number(), v.number()])

/** A parking area as the extract has it, by "way/123", with its middle, and a way's outline */
export const OsmParking = v.object({ id: v.string(), tags: v.record(v.string(), v.string()), center: Lonlat, outline: v.optional(v.array(Lonlat)) })
export type OsmParking = v.InferOutput<typeof OsmParking>

export const OsmParkingList = v.object({
  /** When the extract was made */
  timestamp: v.pipe(v.string(), v.isoTimestamp()),
  elements:  v.array(OsmParking)
})
export type OsmParkingList = v.InferOutput<typeof OsmParkingList>

//#endregion

/** Further than this from ParkMobile's point for its zone, an area's point is wrong, or the zone has moved */
const NEAR = 150 // m

/** How many zones UNH's table has, so a change of layout that reads fewer is a problem rather than a pass */
const UNH_ZONES = 24

export type Sources = { table: readonly TableZone[], parkMobile: readonly ParkMobileZone[], osm: readonly OsmParking[] }

/**
 * The areas checked against the sources, each with its point: the one kept by hand, else its outline's middle, else
 * ParkMobile's point for its zone. Gives back the problems found, which fail the night, and notes of what the sources
 * have that the areas don't, which don't
 */
export const checked = (rules: readonly Rules[], { table, parkMobile, osm }: Sources) => {
  const problems: string[] = []
  const notes: string[] = []
  if (table.length !== UNH_ZONES)
    problems.push(`The zone table read ${table.length} zones, not ${UNH_ZONES}: its layout changed`)
  const byNumber = new Map(rules.filter(area => area.zone).map(area => [area.zone!.number, area]))
  for (const zone of table) {
    const area = byNumber.get(zone.number)
    const [paid, ...more] = area?.zone?.paid ?? []
    if (!area)
      problems.push(`Zone ${zone.number} ${zone.name} is in the zone table but not in areas.mts`)
    else if (more.length || paid.rate !== zone.rate || paid.max !== zone.max || `${paid.days}` !== `${zone.days}` || `${paid.hours}` !== `${zone.hours}`)
      problems.push(`Zone ${zone.number} ${area.name}: areas.mts has ${JSON.stringify(area.zone!.paid)}, the zone table ${JSON.stringify(zone)}`)
  }

  const listed = new Map(parkMobile.map(zone => [+zone.signageAreaCode, zone]))
  for (const zone of parkMobile)
    if (!rules.some(area => area.zone?.number === +zone.signageAreaCode))
      (zone.parkingOperatorName === UNH ? problems : notes).push(`ParkMobile lists ${zone.parkingOperatorName === UNH ? "UNH" : "town"} zone ${zone.signageAreaCode} ${zone.publicInfo}, which areas.mts doesn't`)

  const outlines = new Map(osm.map(element => [element.id, element]))
  const areas = rules.flatMap(rule => {
    const ways = rule.osm.map(id => outlines.get(id) ?? void problems.push(`${rule.name} names ${id}, which isn't a parking area in the extract`))
    const zone = rule.zone && listed.get(rule.zone.number)
    if (rule.zone && !zone)
      problems.push(`${rule.name}: zone ${rule.zone.number} isn't in ParkMobile's list`)
    if (zone && zone.status !== "ACTIVE")
      problems.push(`${rule.name}: ParkMobile has zone ${zone.signageAreaCode} as ${zone.status}`)
    const listedAt: Coordinates | undefined = zone && [zone.displayPoint.lon, zone.displayPoint.lat]
    const at = rule.at ?? ways[0]?.center ?? listedAt
    if (!at) {
      problems.push(`${rule.name} has no point, no outline and no zone: it can't be drawn`)
      return []
    }
    if (listedAt && segmentMeters(at, listedAt) > NEAR)
      problems.push(`${rule.name} is ${segmentMeters(at, listedAt).toFixed(0)} m from ParkMobile's point for zone ${zone!.signageAreaCode}`)
    // Counted only where every outline says, so a part left out never makes it look smaller
    const counts = ways.map(way => Number(way?.tags.capacity))
    const spaces = counts.length && counts.every(count => count > 0) ? counts.reduce((a, b) => a + b) : undefined
    return [v.parse(Area, { ...rule, at, ...spaces && { spaces } })]
  })
  const named = new Set(rules.flatMap(rule => rule.osm))
  for (const element of osm)
    if (element.tags.ref && !named.has(element.id))
      notes.push(`OpenStreetMap's ${element.id} has ref ${element.tags.ref}, which no area names`)
  return { areas, problems, notes }
}
