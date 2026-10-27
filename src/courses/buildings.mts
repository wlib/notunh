// The registrar's building codes as the gazetteer names them. The course API sends each meeting's code and a
// description, with no list of its own, so this table is the list, grown by hand from a full fetch: a code that isn't
// here fails the import (placeOfCode) rather than shipping a class the map can't find. A code mapped to null is
// nowhere the map knows, on purpose: online, TBA, off campus, or a building outside the gazetteer, whose description
// is still shown as text. The gazetteer's names are OpenStreetMap's, and for a building it draws unnamed, ours
// (src/places/added.mts)

/** Codes seen in Fall 2026, J-Term 2027 and Spring 2027, Durham, and what they are */
export const CODES: Record<string, string | null> = {
  TBA:    null,
  ONLINE: null,
  OFFCMP: null,
  ABROAD: null,
  KING:   "Kingsbury Hall",
  HS:     "Hamilton Smith Hall",
  PCBE:   "Paul College",
  HORT:   "Horton Social Science Center",
  PARS:   "Parsons Hall",
  SLS:    "Spaulding Life Sciences",
  JAMS:   "James Hall",
  MURK:   "Murkland Hall",
  DEM:    "DeMeritt Hall",
  PCAC:   "Paul Creative Arts Center",
  MCC:    "McConnell Hall",
  NHH:    "New Hampshire Hall",
  PETT:   "Pettee Hall",
  RUDMAN: "Rudman Hall",
  HEW:    "Hewitt Hall",
  KEND:   "Kendall Hall",
  CHASE:  "Jere A. Chase Ocean Engineering",
  BART:   "Barton Hall",
  COLE:   "Cole Hall",
  GREGG:  "Gregg Hall",
  HUDD:   "Huddleston Hall",
  MORSE:  "Morse Hall",
  ZAIS:   "Zais Hall",
  STOKE:  "Stoke Hall",
  MUB:    "Memorial Union Building",
  SERV:   "Service Building",
  HAALND: "Haaland Hall",
  REC:    "Hamel Rec Center",
  PTNM:   "Putnam Hall",
  LAC:    "Skoglund Livestock Activities Center",
  FH:     "Field House",
  GH:     "Greenhouses",
  LIBR:   "Dimond Library",
  IOL:    "InterOperability Laboratory makerspace",
  CSDC:   "Child Study and Development Center",
  SAWMIL: "UNH Thompson School Sawmill",
  // "Health Services Science Center" in the registrar's data: the Health Sciences Simulation Center, 25 Colovos Rd
  HSSC:   "Health Sciences Simulation Center",
  // Off the map: the Dairy Nutrition Research Center (Fairchild Dairy, Mast Rd), 121 Technology Drive, the Jackson
  // Estuarine Lab (Adams Point), the Browne Center (Dame Rd) and the climbing Boulder Field
  DNRC:   null,
  TECHDR: null,
  JACKSN: null,
  BROWNE: null,
  BOULDR: null
}

export class UnknownBuilding extends Error {
  constructor(code: string, description: string) {
    super(`Unknown building code ${code} (${JSON.stringify(description)}): add it to CODES in src/courses/buildings.mts`)
  }
}

/**
 * The gazetteer name a code means, given the gazetteer's names, or undefined for nowhere. A code not in the table,
 * or a table entry the gazetteer no longer has, throws, so a build never ships a class it can't place
 */
export const placeOfCode = (names: ReadonlySet<string>) => (code: string, description: string): string | undefined => {
  if (!(code in CODES))
    throw new UnknownBuilding(code, description)
  const name = CODES[code]
  if (name !== null && !names.has(name))
    throw new Error(`Building code ${code} maps to ${JSON.stringify(name)}, which the gazetteer doesn't name`)
  return name ?? undefined
}
