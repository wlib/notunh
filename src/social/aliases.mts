// Naming the gazetteer place a venue string means, as the calendars write them: "MUB 164", "behind the MUB", "Paul
// College G75", "Durham, N.H., Lundholm Gymnasium". The longest gazetteer name found in the text wins, after the
// aliases below are read as the names they stand for, so "Hamilton Smith 201" is Hamilton Smith Hall and "T-Hall
// Lawn" is Thompson Hall Lawn rather than Thompson Hall. Nothing found is no place, and the text is shown as it is
//
// The map's place search goes by the same table, and by nicknames too common in prose to read venues by ("Paul",
// "Philly"), so what people type finds what they mean

/** What the calendars and people call places, as the gazetteer names them. Matched as whole words, case aside */
export const ALIASES: Record<string, string> = {
  "MUB":                         "Memorial Union Building",
  "Memorial Union":              "Memorial Union Building",
  "PCAC":                        "Paul Creative Arts Center",
  "T-Hall":                      "Thompson Hall",
  "T Hall":                      "Thompson Hall",
  "T-Hall Lawn":                 "Thompson Hall Lawn",
  "T Hall Lawn":                 "Thompson Hall Lawn",
  "Great Lawn":                  "Thompson Hall Lawn",
  "Ham Smith":                   "Hamilton Smith Hall",
  "Hamilton Smith":              "Hamilton Smith Hall",
  "HoCo":                        "Holloway Commons",
  "Holloway":                    "Holloway Commons",
  "Paul G":                      "Paul College",
  "PCBE":                        "Paul College",
  "Peter T. Paul College":       "Paul College",
  "Paul Arts":                   "Paul Creative Arts Center",
  "Paul Creative Arts":          "Paul Creative Arts Center",
  "Fishbowl":                    "Scott Hall",
  "Scott Lawn":                  "Scott Hall",
  "Lundholm Gymnasium":          "Field House",
  "Lundholm":                    "Field House",
  "Swasey Pool":                 "Field House",
  "Swasey Indoor Pool":          "Field House",
  "Whittemore Center":           "Whittemore Center Arena",
  "Whittemore Center at Key Auto Group Complex": "Whittemore Center Arena",
  "Marini Auditorium":           "Paul College",
  "Hamel":                       "Hamel Rec Center",
  "Hamel Recreation Center":     "Hamel Rec Center",
  "HRC":                         "Hamel Rec Center",
  "Student Recreation Field":    "Student Rec Field",
  "Student Recreation Fields":   "Student Rec Field",
  "Lewis Fields":                "Tucker Field",
  "Lewis Field":                 "Tucker Field",
  "Saw Mill":                    "UNH Thompson School Sawmill",
  "Sawmill":                     "UNH Thompson School Sawmill",
  "Dimond":                      "Dimond Library",
  "Chase Ocean Engineering":     "Jere A. Chase Ocean Engineering",
  "Chase Ocean Engineering Laboratory": "Jere A. Chase Ocean Engineering",
  "ECenter":                     "Peter And Paula Vosotas Career Center",
  "Elliot Alumni":               "Elliot Alumni Center",
  "Murkland":                    "Murkland Hall",
  "McConnell":                   "McConnell Hall",
  "Spaulding":                   "Spaulding Life Sciences",
  "Kingsbury":                   "Kingsbury Hall",
  "Demerit Hall":                "DeMeritt Hall",
  "Demeritt Hall":               "DeMeritt Hall",
  "Mills":                       "Mills Hall",
  "A-Lot":                       "Lot S",
  "A Lot":                       "Lot S"
}

/**
 * What people type for places that also mean other things in an event's text, as "Paul" is someone and "Philly" a
 * cheesesteak: searched by, never read in a venue
 */
export const NICKNAMES: Record<string, string> = {
  "Philly":     "Philbrook Hall",
  "Paul":       "Paul College",
  "Whittemore": "Whittemore Center Arena",
  "Whitt":      "Whittemore Center Arena",
  "The Whitt":  "Whittemore Center Arena"
}

/** A hall or library by its first word, as "Morse" is Morse Hall and "Dimond" Dimond Library: each short name and the name it stands for */
export const shortNames = (names: readonly string[]) =>
  names.flatMap(name => /^\S+ (Hall|Library)$/.test(name) ? [[name.split(" ")[0], name] as const] : [])

/**
 * The other names each of some places goes by, as the map's search finds them, given any more besides: the table's,
 * the nicknames, and a hall's or library's first word, each once
 */
export const otherNames = (names: readonly string[], more: readonly (readonly [string, string])[] = []) => {
  const known = new Set(names)
  const others = new Map<string, Set<string>>()
  for (const [alias, name] of [...Object.entries(ALIASES), ...Object.entries(NICKNAMES), ...shortNames([...known]), ...more])
    if (known.has(name))
      others.set(name, (others.get(name) ?? new Set()).add(alias))
  return new Map([...others].map(([name, aliases]) => [name, [...aliases]]))
}

/** A pattern finding some names in text as whole words, longest first, whatever their case */
const patternOf = (names: readonly string[]) =>
  new RegExp(`(?<![\\w])(?:${[...names].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w])`, "gi")

/**
 * Finds the gazetteer place some text means, given the gazetteer's names and any other names for them, and the words
 * that named it, or none: the longest name found wins
 */
export const placeFinder = (names: readonly string[], others: readonly (readonly [string, string])[] = []) => {
  const known = new Set(names)
  const aliases = [...Object.entries(ALIASES), ...others].filter(([, name]) => known.has(name))
  const byLower = new Map([...names.map(name => [name.toLowerCase(), name] as const), ...aliases.map(([alias, name]) => [alias.toLowerCase(), name] as const)])
  const pattern = patternOf([...byLower.keys()])
  return (text: string): { place: string, found: string } | undefined => {
    const found = byLower.size ? [...text.matchAll(pattern)].map(([match]) => match).sort((a, b) => b.length - a.length)[0] : undefined
    return found ? { place: byLower.get(found.toLowerCase())!, found } : undefined
  }
}

/** Finds the gazetteer place a venue string means, given the gazetteer's names, or none */
export const placeMatcher = (names: readonly string[]) => {
  const find = placeFinder(names)
  return (text: string) => find(text)?.place
}
