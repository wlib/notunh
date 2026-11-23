// The numbers worth having on the Durham campus, emergency first, each from a unh.edu page and none from memory: a
// page of their own in the sheet (ui/Phones.tsx), found by search, and in directions, UNH Police's walking escort where
// no bus goes between two places on campus. Curated by hand, and checked against the pages named on 2026-11-23. A
// number a page didn't confirm is left out: Residential Life's on-call line, which UNH posts in each hall instead, and
// the 24-hour support page's "(603) 862-1212" for UNH Police, which UNH Police's own pages never give

import { type Box, holds } from "../geo/boxes.mts"
import type { Point } from "../geo/projection.mts"

export type Phone = {
  name:   string,
  /** As UNH writes it, "(603) 862-1427" */
  number: string,
  /** What it's for, and when, in UNH's terms */
  note?:  string,
  /** What else it's searched by than its name: what people call it, and what they'd want it for */
  words?: string,
  /** The unh.edu page that gives the number */
  source: string
}

export type Phones = { heading: string, phones: Phone[] }

/** The number to dial, "+16038621427", or a short code like 911 as it is */
export const telOf = ({ number }: Phone) => {
  const digits = number.replace(/\D/g, "")
  return digits.length === 10 ? `+1${digits}` : digits
}

const POLICE  = "https://www.unh.edu/upd/contact-us"
const CENTER  = "https://www.unh.edu/upd/communications-division"
const PACS    = "https://www.unh.edu/pacs/crisis-emergency-services"
const CONTACT = "https://www.unh.edu/about/contact-us"
const TRANSIT = "https://www.unh.edu/transportation/about/contact-us"

/** UNH Police's dispatch, the Communications Center, staffed at any hour, which sends a walking escort too */
export const DISPATCH: Phone = { name: "UNH Police dispatch", number: "(603) 862-1427", note: "Not an emergency · any hour", words: "security safety escort", source: CENTER }

export const PHONES: Phones[] = [
  {
    heading: "Emergency",
    phones: [
      { name: "Emergency", number: "911", note: "Police, fire or medical", words: "police fire medical ambulance", source: POLICE },
      DISPATCH
    ]
  },
  {
    heading: "Any hour",
    phones: [
      { name: "SHARPP helpline", number: "(603) 862-7233", note: "Sexual and relationship violence · confidential", words: "sexual assault harassment relationship violence", source: "https://www.unh.edu/sharpp/contact-us" },
      { name: "Psychological & Counseling Services", number: "(603) 862-9355", note: "Crisis help any hour · after 5 PM and weekends, press 0", words: "pacs crisis mental health", source: PACS },
      { name: "Suicide & Crisis Lifeline", number: "988", source: PACS }
    ]
  },
  {
    heading: "Campus",
    phones: [
      { name: "Health & Wellness", number: "(603) 862-9355", note: "Appointments and medical care", words: "medical doctor nurse appointments", source: "https://www.unh.edu/health/" },
      { name: "Transportation", number: "(603) 862-2328", note: "Buses and the Connector", words: "buses shuttle transit connector", source: TRANSIT },
      { name: "Parking", number: "(603) 862-1010", source: TRANSIT },
      { name: "IT Service Desk", number: "(603) 862-2525", words: "computer wifi password", source: CONTACT },
      // That the RA on call's number is posted in each hall is the 24-hour support page's,
      // https://students.unh.edu/health-student-support/24-hour-support
      { name: "Residential Life", number: "(603) 862-2268", note: "Your hall's RA on call is posted in the building", words: "reslife dorm", source: CONTACT },
      { name: "Dean of Students", number: "(603) 862-2053", source: CONTACT },
      { name: "Facilities", number: "(603) 862-1437", words: "maintenance repairs", source: CONTACT },
      { name: "UNH information", number: "(603) 862-1234", source: CONTACT }
    ]
  }
]

/** What the page's own row is found by, besides any number's name or words */
const WORDS = ["phone", "numbers", "help"]

/** Text as words, lowercased, without punctuation */
const wordsOf = (text: string) =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * What search finds for what's typed, three letters or more: the numbers each of whose words a word of the number's
 * name, or of what else it's searched by, starts with, and the page of them all, for those or a word like "phone".
 * Never by a note's prose, whose "and", "the" and "week" are in anything typed
 */
export const phonesFor = (typed: string) => {
  const typedWords = wordsOf(typed)
  if (typedWords.join(" ").length < 3)
    return { isPage: false, phones: [] }
  const phones = PHONES.flatMap(({ phones }) => phones).filter(phone => {
    const words = wordsOf(`${phone.name} ${phone.words ?? ""}`)
    return typedWords.every(typed => words.some(word => word.startsWith(typed)))
  })
  return { isPage: phones.length > 0 || typedWords.some(typed => WORDS.some(word => word.startsWith(typed))), phones }
}

//#region The walking escort

// UNH Police say it on https://www.unh.edu/upd/services-outreach/new-student-resources and, as free of charge, on
// https://www.unh.edu/upd/about-department/support-services-division: Transportation is the first to call, and where
// the shuttle isn't running Security walks you to and from on-campus locations, asked for on dispatch's number

/** How far a walk is before an escort's worth offering, about ten minutes */
const ESCORT_METERS = 800

/**
 * Whether directions offer UNH Police's walking escort: with no bus to take, for a walk of some length from one place
 * on campus to another, as it's only between on-campus locations. The campus is as the gazetteer has it (campusOf in
 * src/places/gazetteer.mts), and without it nothing's offered
 */
export const offersEscort = ({ from, to, hasBus, meters, campus }: { from: Point, to: Point, hasBus: boolean, meters: number, campus: Box | undefined }) =>
  !hasBus && meters >= ESCORT_METERS && campus !== undefined && holds(campus, from) && holds(campus, to)

//#endregion
