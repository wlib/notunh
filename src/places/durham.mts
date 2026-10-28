// Durham, the town campus is in: the middle of campus, which search and a name on two places prefer the nearer to;
// how far from it a place is still in town; and the town's postal address, which structured data gives its places

import { type Point, distance } from "../geo/projection.mts"

/** The middle of campus */
export const CAMPUS: Point = { lat: 43.1365, lon: -70.9345 }

/** How far from the middle of campus a place is still in Durham */
const TOWN_METERS = 5000

export const isInDurham = (at: Point) =>
  distance(at, CAMPUS) <= TOWN_METERS

/** Where Durham's places are, by the town's own post office, as a postal address says it */
export const ADDRESS = { addressLocality: "Durham", addressRegion: "NH", postalCode: "03824", addressCountry: "US" }
