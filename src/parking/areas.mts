// UNH's parking areas and pay-per-hour zones, by hand, from the August 2026 parking map's key, the 2026 pay-per-hour
// table (parking-meter-info.pdf), the enforcement hours (parking-policies), and the visitor page's per-lot notes.
// Joined to OpenStreetMap by way id where OSM draws the area with a ref or name. An area with no `osm` has no outline
// on the map yet: it gets a marker at `at`, which is ParkMobile's display point for a zone and a guess beside the
// building otherwise (`guessed`, never a place to route from).
//
// Only what the sources say for certain is kept. Of the winter ban, only the resident lots both UNH's winter page and
// its grid of lots keep open to permit holders all night (model.mts); everything else that winter changes, per lot or
// on a snow emergency, is left to UNH's page, which the sources disagree on. The town's lots are left to the town's
// page too, as their rates step up by the hour and cap by the day in ways these rules can't say (Parking.tsx links
// both). Lot A's rear sections, nearest the Gables, the winter page treats apart from the rest of A, so they're their
// own row: the smallest area with a rule of its own is the unit, not the lot. Checked against the sources 26 Oct
// 2026, and each night against those a machine can read (scripts/map/parking.mts)

import type { Coordinates } from "../geo/projection.mts"
import { type Area, EVERY_DAY, WEEKDAYS } from "./model.mts"

/** An area as kept here, before its point is filled from OpenStreetMap or ParkMobile where it isn't given */
export type Rules = Omit<Area, "at"> & { at?: Coordinates }

const PAID = 1.85

/** Paid weekdays 7 to 6, and paid every day 7 to 9, as the two kinds of UNH zone are */
const weekday = (number: number, max: number): Area["zone"] => ({ number, paid: [{ days: WEEKDAYS, hours: [7 * 60, 18 * 60], rate: PAID, max }] })
const visitor = (number: number, max: number): Area["zone"] => ({ number, paid: [{ days: EVERY_DAY, hours: [7 * 60, 21 * 60], rate: PAID, max }] })

/** Open to its permit holders all night through the winter ban, as both UNH's winter page and its grid of lots say */
const PERMIT_HOLDERS = "permit-holders"

const guess = (lon: number, lat: number) => ({ at: [lon, lat] as Coordinates, guessed: true, notes: "Point is a guess beside the building" })

export const AREAS: Rules[] = [
  // Commuter lots
  { id: "G1", name: "G1 Lot", permits: ["commuter"], always: false, osm: ["way/28336373"] },
  { id: "moiles", name: "Moiles Lot", permits: ["commuter"], always: false, osm: ["way/28210629"] },
  // Faculty and staff lots
  { id: "B", name: "B Lot", permits: ["faculty"], always: false, osm: ["way/27805292"] },
  { id: "B-meters", name: "Lot B meter spaces", permits: [], always: false, osm: [], at: [-70.93209, 43.13225], zone: weekday(98714, 2) },
  { id: "barton", name: "Barton Lot", permits: ["faculty"], always: false, osm: [], ...guess(-70.93873, 43.1422) },
  { id: "brook-way", name: "Brook Way Lot", permits: ["faculty"], always: false, osm: ["way/28323439"], zone: weekday(98705, 3) },
  { id: "D", name: "D Lot", permits: ["faculty"], always: false, osm: ["way/27806469"] },
  { id: "fh-east", name: "Field House East", permits: ["faculty"], always: false, osm: [], ...guess(-70.9378, 43.13928) },
  { id: "G", name: "G Lot", permits: ["faculty"], always: false, osm: ["way/28323271"] },
  { id: "gregg", name: "Gregg Lot", permits: ["faculty"], always: false, osm: [], ...guess(-70.9379, 43.13544) },
  { id: "leavitt", name: "Leavitt Lane 1 & 2", permits: ["faculty"], always: false, osm: ["way/1291884205"] },
  { id: "N", name: "N Lot", permits: ["faculty"], always: false, osm: ["way/37749738"] },
  { id: "P", name: "P Lot", permits: ["faculty"], always: false, osm: ["way/28335732"] },
  { id: "stadium", name: "Stadium Lot", permits: ["faculty"], always: false, osm: [], ...guess(-70.93908, 43.13957) },
  // Resident lots: a permit for that lot, around the clock, and through the winter ban where both UNH sources agree
  { id: "E", name: "E Lot", permits: [{ resident: "E" }], always: true, winter: PERMIT_HOLDERS, osm: ["way/28336492"] },
  { id: "E1", name: "E1 Lot", permits: [{ resident: "E1" }], always: true, winter: PERMIT_HOLDERS, osm: ["way/28336511"] },
  { id: "E2", name: "E2 Lot", permits: [{ resident: "E2" }], always: true, winter: PERMIT_HOLDERS, osm: ["way/28551013"] },
  { id: "evergreen", name: "Evergreen Lot", permits: [{ resident: "evergreen" }], always: true, osm: [], ...guess(-70.93588, 43.14591) },
  { id: "F", name: "F Lot", permits: [{ resident: "F" }], always: true, osm: ["way/27990864"] },
  { id: "gables", name: "Gables Lot", permits: [{ resident: "gables" }], always: true, winter: PERMIT_HOLDERS, osm: [], ...guess(-70.93702, 43.14339) },
  { id: "gables-visitor", name: "Gables visitor spaces", permits: [], always: true, osm: [], at: [-70.93525, 43.1449], zone: weekday(98711, 12) },
  { id: "strafford", name: "Strafford Lot", permits: [{ resident: "strafford" }], always: true, osm: ["way/28336080"] },
  { id: "woodsides", name: "Woodsides Lot", permits: [{ resident: "woodsides" }], always: true, winter: PERMIT_HOLDERS, osm: [], ...guess(-70.93405, 43.14084) },
  { id: "woodside-visitor", name: "Woodside visitor spaces", permits: [], always: true, osm: [], at: [-70.93446, 43.14053], zone: weekday(98721, 12) },
  // Mixed lots; those with resident parking check permits around the clock. The winter page treats A's rear apart
  { id: "A", name: "A Lot", permits: ["commuter", "faculty"], always: false, osm: ["way/27805654"] },
  { id: "A-rear", name: "A Lot sections 3 & 4", permits: ["commuter", "faculty"], always: false, osm: [], ...guess(-70.9305, 43.1445), notes: "The rear of A nearest the Gables" },
  { id: "M", name: "M Lot", permits: ["commuter", "faculty"], always: false, osm: ["way/28336384"] },
  { id: "mast-road", name: "Mast Road Lot", permits: ["commuter", "resident-west", "faculty", "non-resident"], always: true, osm: ["relation/4056604"] },
  { id: "mathes", name: "Mathes Lots", permits: ["commuter", "resident-west", "faculty", "non-resident"], always: true, osm: [], ...guess(-70.94071, 43.14248) },
  { id: "west-edge", name: "West Edge Lot", permits: ["commuter", "resident-west", "faculty", "non-resident"], always: true, osm: ["way/27990592", "way/1291619639"] },
  // Visitor lots, paid seven days 7 to 9
  { id: "sage-way", name: "Sage Way Visitor Lot", permits: [], always: false, osm: [], at: [-70.93839, 43.14117], zone: visitor(98717, 14), notes: "20 Sage Way, by the Transit Center" },
  { id: "edgewood", name: "Edgewood Rd Visitor Lot", permits: [], always: false, osm: [], at: [-70.93321, 43.13834], zone: visitor(98709, 4), notes: "5 Edgewood Rd, by the Whittemore Center" },
  { id: "campus-crossing", name: "Campus Crossing Visitor Lot", permits: [], always: false, osm: [], at: [-70.9283, 43.13346], zone: visitor(98706, 12), notes: "8 Mill Rd" },
  { id: "college-rd", name: "College Rd Visitor Lot", permits: [], always: false, osm: [], at: [-70.93658, 43.13432], zone: visitor(98708, 4), notes: "McDaniel Dr, across from Morse Hall; not the F Lot beside it" },
  { id: "t-hall", name: "Thompson Hall Lot", permits: [], always: false, purpose: "errands", osm: [], at: [-70.932, 43.13581], zone: visitor(98720, 1), notes: "Short errands only, not for class; no drop-offs" },
  // Other pay-per-hour, weekdays 7 to 6
  { id: "academic-way-east", name: "Academic Way East", permits: [], always: false, osm: [], at: [-70.93214, 43.13313], zone: weekday(98701, 2) },
  { id: "academic-way-west", name: "Academic Way West", permits: [], always: false, osm: [], at: [-70.93271, 43.1336], zone: weekday(98702, 2) },
  { id: "ballard-loop", name: "Ballard Loop", permits: [], always: false, osm: [], at: [-70.93077, 43.13763], zone: weekday(98703, 2) },
  { id: "ballard-st", name: "Ballard Street", permits: [], always: false, osm: [], at: [-70.93004, 43.13758], zone: weekday(98704, 2) },
  { id: "college-rd-morrill", name: "College Rd at Morrill", permits: [], always: false, osm: [], at: [-70.93464, 43.13737], zone: weekday(98707, 2) },
  { id: "fh-front", name: "Field House Front", permits: [], always: false, osm: [], at: [-70.93787, 43.13927], zone: weekday(98710, 3) },
  { id: "health-wellness", name: "Health & Wellness", permits: [], always: false, osm: [], at: [-70.92809, 43.13594], zone: weekday(98712, 2) },
  { id: "library-way-west", name: "Library Way West", permits: [], always: false, osm: [], at: [-70.9364, 43.13715], zone: weekday(98713, 3) },
  { id: "morse-pad", name: "Morse Pad", permits: [], always: false, osm: ["way/28550935"], zone: weekday(98715, 2) },
  { id: "Q", name: "Q Lot (Quad)", permits: [], always: false, osm: ["way/55056715"], zone: weekday(98716, 3) },
  { id: "serc", name: "SERC (DeMeritt Circle)", permits: [], always: false, osm: [], at: [-70.93742, 43.13289], zone: weekday(98718, 12) },
  { id: "service", name: "Service Lot", permits: [], always: false, osm: [], at: [-70.93565, 43.1365], zone: weekday(98719, 2) },
  { id: "Z1", name: "Z Lot 1 (Dairy Bar)", permits: [], always: false, osm: [], at: [-70.93594, 43.13936], zone: weekday(98722, 1) },
  { id: "Z2", name: "Z Lot 2 (Memorial Field)", permits: [], always: false, osm: [], at: [-70.93536, 43.13862], zone: weekday(98723, 2) },
  { id: "fh-west", name: "Field House West (gravel)", permits: [], always: false, osm: [], at: [-70.94043, 43.13976], zone: weekday(98724, 5) },
]
