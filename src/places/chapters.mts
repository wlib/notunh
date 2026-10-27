// UNH's fraternities and sororities in Durham, each as UNH recognizes it and as students name it, and its house where
// the map can place one. Reviewed by hand, as chapters change a few times a decade, against these, as of 27 Oct 2026:
//
// - Which chapters, and each one's designation and council: UNH's chapter scorecards, which UNH says are all
//   recognized (students.unh.edu/get-involved/fraternity-sorority-life/chapter-scorecards), and the social
//   fraternities and sororities registered on Wildcat Link (unh.presence.io). Those UNH has suspended or unrecognized
//   are left out (students.unh.edu/get-involved/fraternity-sorority-life/unrecognized-organizations)
// - A house's address and spot: Durham's parcels (the town's Parcels_Current layer on ArcGIS Online, from its
//   assessing records), whose fraternity and sorority parcels name the chapter or its house corporation as owner,
//   and the OpenStreetMap building inside that parcel, as the gazetteer has it or by its middle. Otherwise two
//   sources that agree. A house no source places isn't guessed at; it's found by search, saying so
// - Nicknames: each confirmed by a source said beside it, the national organization's own site, the chapter's, or
//   UNH's and Wildcat Link's pages for it; one nothing confirms is left out
//
// A chapter's house joins the gazetteer by its name, taking the outline and doors of the building it's in, in place
// of whatever OpenStreetMap calls that building (withChapters), so it's searched, tapped and walked to like any
// other. To update: check the scorecards page and Wildcat Link against this list, and for a new house, find its
// parcel on Durham's map and the building in it, and copy that building's middle as `at`

import { holds, outlineHolds } from "../geo/boxes.mts"
import { type Coordinates, distance } from "../geo/projection.mts"
import type { GazetteerPlace } from "./gazetteer.mts"

export type Council = "Interfraternity Council" | "Panhellenic Council"

export type Chapter = {
  /** As UNH names it, which is its letters spelled out */
  name:         string,
  letters:      string,
  kind:         "fraternity" | "sorority",
  council:      Council,
  /** The national organization's name for the chapter, like "Gamma Mu" */
  designation?: string,
  /** Nicknames and abbreviations students use, each confirmed by a source */
  aliases:      string[],
  /** UNH's page for the chapter */
  url:          string,
  /** Its house, by address, and where the map places it, as lon, lat, where that's known */
  house?:       { address: string, at?: Coordinates }
}

const SCORECARD = "https://students.unh.edu/campus-life/fraternity-sorority-life/chapter-scorecards/"

export const CHAPTERS: Chapter[] = [
  // Interfraternity Council

  {
    name:        "Alpha Gamma Rho",
    letters:     "ΑΓΡ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Omega",
    // "AGR": OpenStreetMap names its house so, way 83115274, in Durham's parcel at 6 Strafford Ave, which the
    // chapter owns
    aliases:     ["AGR"],
    url:         SCORECARD + "alpha-gamma-rho",
    house:       { address: "6 Strafford Ave", at: [-70.92711, 43.13802] }
  },
  {
    name:        "Alpha Sigma Phi",
    letters:     "ΑΣΦ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Beta Eta",
    // "Alpha Sig": alphasigmaphi.org, and the chapter's Instagram, alphasigunh. Wildcat Link has it meet in Paul
    // College, and no Durham parcel or other source gives it a house
    aliases:     ["Alpha Sig"],
    url:         SCORECARD + "alpha-sigma-phi"
  },
  {
    name:        "Alpha Tau Omega",
    letters:     "ΑΤΩ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Delta Delta",
    // "ATO": ato.org, and the chapter's Instagram, unh_ato. Durham's planning board approved the chapter's house at
    // 18 Garrison Ave in 2020, "formerly UNH's Elizabeth DeMeritt House", which is the building in that parcel,
    // OpenStreetMap's way 28777455. OpenStreetMap names the building next door, in the parcel at 22 Garrison Ave,
    // Alpha Tau Omega, which the house takes the place of too
    aliases:     ["ATO"],
    url:         "https://students.unh.edu/get-involved/fraternity-sorority-life/chapter-scorecards/alpha-tau-omega",
    house:       { address: "18 Garrison Ave", at: [-70.92725, 43.13721] }
  },
  {
    name:        "Beta Theta Pi",
    letters:     "ΒΘΠ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    // New at UNH: registered on Wildcat Link as a social fraternity, holding events there this fall, and in Beta's
    // 2026-27 chapter directory as New Hampshire, though not yet among UNH's scorecards. "Beta": beta.org. No
    // house
    aliases:     ["Beta"],
    url:         "https://unh.presence.io/organization/beta-theta-pi"
  },
  {
    name:        "Lambda Chi Alpha",
    letters:     "ΛΧΑ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Alpha Xi",
    // "Lambda Chi": lambdachi.org, and the chapter's Instagram, lambdachi_unh; "LCA": lambdachi.org ("LCA Academy").
    // Its house is OpenStreetMap's way 83115271, at 35 Madbury Rd, a fraternity parcel by Durham's, the address
    // the chapter's corporation files with the IRS too
    aliases:     ["Lambda Chi", "LCA"],
    url:         SCORECARD + "lambda-chi-alpha",
    house:       { address: "35 Madbury Rd", at: [-70.92652, 43.13826] }
  },
  {
    name:        "Pi Kappa Alpha",
    letters:     "ΠΚΑ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Gamma Mu",
    // "Pike": pikes.org, the chapter's Wildcat Link page ("PIKE") and its Instagram, unhpikes. Wildcat Link has it
    // meet at 5 Strafford Ave, Durham's parcel there is the Gamma Mu Alumni Association's, and the building in it is
    // OpenStreetMap's way 83247623
    aliases:     ["Pike", "Pikes"],
    url:         SCORECARD + "pi-kappa-alpha",
    house:       { address: "5 Strafford Ave", at: [-70.92784, 43.13813] }
  },
  {
    name:        "Pi Kappa Phi",
    letters:     "ΠΚΦ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Iota Delta",
    // "Pi Kapp": pikapp.org, and the chapter's Instagram, unh_pikapp. OpenStreetMap's node 13797305891, in Durham's
    // parcel at 8 Madbury Ct, the address the chapter's corporation files with the IRS
    aliases:     ["Pi Kapp"],
    url:         SCORECARD + "pi-kappa-phi",
    house:       { address: "8 Madbury Ct", at: [-70.92718, 43.13942] }
  },
  {
    name:        "Sigma Beta",
    letters:     "ΣΒ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    // A local fraternity, with no national designation. OpenStreetMap's way 83256510, in Durham's parcel at 26
    // Madbury Rd, which the Sigma Beta Alumni Association owns
    aliases:     [],
    url:         SCORECARD + "sigma-beta",
    house:       { address: "26 Madbury Rd", at: [-70.92529, 43.13716] }
  },
  {
    name:        "Sigma Chi",
    letters:     "ΣΧ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Lambda Sigma",
    // "Sig Chi": UConn's, Chico State's and North Alabama's pages for their chapters. OpenStreetMap's way 83104554,
    // which it numbers 8 Madbury Rd, is in Durham's fraternity parcel at 10, where the chapter's site, sigmachiunh.org,
    // has its brothers
    aliases:     ["Sig Chi"],
    url:         SCORECARD + "sigma-chi",
    house:       { address: "10 Madbury Rd", at: [-70.92484, 43.13541] }
  },
  {
    name:        "Tau Kappa Epsilon",
    letters:     "ΤΚΕ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Alpha Nu",
    // "TKE" and "Teke": tke.org, and the chapter's Instagram, unh_tke. Only directory listings (MapQuest,
    // yellow.place) give a house, at 35 Madbury Rd, which OpenStreetMap and the IRS have as Lambda Chi Alpha's, and no
    // Durham parcel names it
    aliases:     ["TKE", "Teke"],
    url:         SCORECARD + "tau-kappa-epsilon"
  },
  {
    name:        "Theta Chi",
    letters:     "ΘΧ",
    kind:        "fraternity",
    council:     "Interfraternity Council",
    designation: "Zeta",
    // The chapter's site, thetachiunh.com, gives 2 Strafford Ave, a fraternity parcel by Durham's, and OpenStreetMap's
    // way 83115267 by its address
    aliases:     [],
    url:         SCORECARD + "theta-chi",
    house:       { address: "2 Strafford Ave", at: [-70.927, 43.13771] }
  },

  // Panhellenic Council

  {
    name:        "Alpha Chi Omega",
    letters:     "ΑΧΩ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Alpha Tau",
    // "Alpha Chi" and "AXO": alphachiomega.org. OpenStreetMap's way 83106105, in Durham's parcel at 29 Madbury Rd,
    // which Alpha Chi Omega's national housing corporation owns
    aliases:     ["Alpha Chi", "AXO"],
    url:         SCORECARD + "alpha-chi-omega",
    house:       { address: "29 Madbury Rd", at: [-70.92625, 43.13738] }
  },
  {
    name:        "Alpha Phi",
    letters:     "ΑΦ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Eta Alpha",
    // "APhi" and "A Phi": Texas's, Arkansas's and Michigan State's pages for their chapters. Durham's parcel at 8
    // Strafford Ave is Alpha Phi International's, and the building in it is OpenStreetMap's way 83115264
    aliases:     ["APhi", "A Phi"],
    url:         SCORECARD + "alpha-phi",
    house:       { address: "8 Strafford Ave", at: [-70.9273, 43.1384] }
  },
  {
    name:        "Alpha Xi Delta",
    letters:     "ΑΞΔ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Tau",
    // "AXiD": alphaxidelta.org; "Alpha Xi": the chapter's site, unh.alphaxidelta.org, which gives 3 Strafford Ave.
    // Durham's parcel there is Alpha Xi Delta New Hampshire's, and the building in it is OpenStreetMap's way
    // 83113856, which it numbers 1
    aliases:     ["AXiD", "Alpha Xi"],
    url:         SCORECARD + "alpha-xi-delta",
    house:       { address: "3 Strafford Ave", at: [-70.92757, 43.13759] }
  },
  {
    name:        "Chi Omega",
    letters:     "ΧΩ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Mu Alpha",
    // "Chi O": chiomega.com. Durham's parcel at 11 Strafford Ave is the Mu Alpha Building Association's, the address
    // the chapter files with the IRS, and the building in it is OpenStreetMap's way 83247620. UNH lists it as a
    // member and as an associate chapter both
    aliases:     ["Chi O"],
    url:         SCORECARD + "chi-omega",
    house:       { address: "11 Strafford Ave", at: [-70.92822, 43.13879] }
  },
  {
    name:        "Kappa Delta",
    letters:     "ΚΔ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Alpha Sigma",
    // "KD": kappadelta.org. Its Wildcat Link page gives 25 Madbury Rd, OpenStreetMap's way 83105727, in Durham's
    // parcel there, which the Alpha Sigma House Corporation owns
    aliases:     ["KD"],
    url:         SCORECARD + "kappa-delta",
    house:       { address: "25 Madbury Rd", at: [-70.9261, 43.13687] }
  },
  {
    name:        "Phi Sigma Sigma",
    letters:     "ΦΣΣ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Iota Upsilon",
    // "Phi Sig": the chapter's Instagram, unhphisig. OpenStreetMap's way 83113859, which it numbers 17 Garrison Ave,
    // is in Durham's sorority parcel at 2 Brook Way
    aliases:     ["Phi Sig"],
    url:         SCORECARD + "phi-sigma-sigma",
    house:       { address: "2 Brook Way", at: [-70.92807, 43.13771] }
  },
  {
    name:        "Sigma Alpha",
    letters:     "ΣΑ",
    kind:        "sorority",
    council:     "Panhellenic Council",
    designation: "Beta Kappa",
    // A professional agricultural sorority, as Wildcat Link has it, which meets in the MUB and has no house; UNH's
    // scorecard puts it in the Panhellenic Council
    aliases:     [],
    url:         SCORECARD + "sigma-alpha"
  }
]

/** The chapter a place is, by its name */
export const chapterNamed = (name: string) =>
  CHAPTERS.find(chapter => chapter.name === name)

/** Every name a chapter is searched by besides its own: its letters, and its nicknames */
export const aliasesOf = (chapter: Chapter) =>
  [chapter.letters, ...chapter.aliases]

/** Whether the map places a chapter's house */
export const isPlaced = (chapter: Chapter): chapter is Chapter & { house: { at: Coordinates } } =>
  chapter.house?.at !== undefined

// A place named for a chapter this near its house is the house, as OpenStreetMap may draw it as a point beside
const NEAR = 40 // m

/** A name as two spellings of it compare, in letters and digits alone */
const bare = (name: string) =>
  name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

/**
 * Some places with each chapter's house the map places among them, named for the chapter, in place of the places that
 * are it: the building its spot is in, whose outline, doors and middle it takes, whatever OpenStreetMap names that,
 * and anything nearby by one of its names. In the gazetteer's order by name
 */
export const withChapters = (places: readonly GazetteerPlace[]) => {
  const claimed = new Set<GazetteerPlace>()
  const houses = CHAPTERS.filter(isPlaced).map(chapter => {
    const [lon, lat] = chapter.house.at
    const names = new Set([chapter.name, ...aliasesOf(chapter)].map(bare))
    const building = places.find(place =>
      place.kind === "building" && place.extent && holds(place.extent, { lon, lat }) && (!place.outline || outlineHolds(place.outline, { lon, lat }))
    )
    for (const place of places)
      if (place === building || names.has(bare(place.name)) && distance({ lon: place.at[0], lat: place.at[1] }, { lon, lat }) <= NEAR)
        claimed.add(place)
    const { extent, outline, entrances } = building ?? {}
    return {
      name: chapter.name,
      kind: "building",
      at:   building?.at ?? chapter.house.at,
      ...extent && { extent },
      ...outline && { outline },
      ...entrances && { entrances }
    }
  })
  return [...places.filter(place => !claimed.has(place)), ...houses].sort((a, b) => a.name.localeCompare(b.name, "en"))
}
