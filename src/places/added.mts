// Places OpenStreetMap draws but doesn't name yet, named here so the map can search, place and walk to them as it
// does the gazetteer's. Each is the gazetteer's own shape, taken from the extract's outline of the building, and
// joins the gazetteer as it loads (Gazetteer in gazetteer.mts) unless a generation names it already, so one drawn
// and named upstream drops out here without a change. Places it misnames are renamed here too, likewise only while
// a generation still has the wrong name

import type { GazetteerPlace } from "./gazetteer.mts"

export const ADDED: GazetteerPlace[] = [
  // UNH's Health Sciences Simulation Center, 25 Colovos Rd, "Health Services Science Center" (HSSC) in the
  // registrar's data (src/courses/buildings.mts), as the user confirmed. OpenStreetMap's way 1342295228, the one
  // unnamed building=university between Gregg Hall and Ritzman Lab off Waterworks Rd, where UNH says the center is
  // (unh.edu/unhtoday, tnhdigital.com), its outline and door as the extract of 20 Oct 2026 draws them
  {
    name:      "Health Sciences Simulation Center",
    kind:      "building",
    at:        [-70.93822, 43.13565],
    extent:    [-70.93853, 43.13528, -70.93784, 43.13603],
    outline:   [[[-70.93847, 43.1357], [-70.93853, 43.13549], [-70.93845, 43.13548], [-70.93842, 43.13548], [-70.93842, 43.13545], [-70.93836, 43.13544], [-70.9384, 43.13532], [-70.93815, 43.13528], [-70.93806, 43.13559], [-70.93819, 43.13561], [-70.93818, 43.13564], [-70.93817, 43.13567], [-70.93815, 43.13568], [-70.93816, 43.13569], [-70.93784, 43.1359], [-70.938, 43.13603], [-70.93833, 43.13581], [-70.93831, 43.1358], [-70.93832, 43.13579], [-70.93833, 43.13579], [-70.9384, 43.13575], [-70.93838, 43.13573], [-70.93838, 43.13572], [-70.93839, 43.13569]]],
    entrances: [[-70.93818, 43.13564]]
  },
  // UNH's 1 Leavitt Lane, by the Leavitt Lane lot off Main St, home of UNH Online and Continuing Education
  // (online.unh.edu/contact) and a data center of UNH IT (td.usnh.edu). OpenStreetMap's way 79056848, which it
  // addresses 1 Leavitt Lane, its outline and door as the extract of 18 Oct 2026 draws them
  {
    name:      "1 Leavitt Lane",
    kind:      "building",
    at:        [-70.95247, 43.14362],
    extent:    [-70.95286, 43.14331, -70.95203, 43.14393],
    outline:   [[[-70.95226, 43.14331], [-70.9522, 43.14342], [-70.95203, 43.14371], [-70.95276, 43.14393], [-70.9528, 43.14385], [-70.95276, 43.14384], [-70.9528, 43.14377], [-70.95278, 43.14376], [-70.95285, 43.14364], [-70.95279, 43.14362], [-70.95281, 43.14359], [-70.95286, 43.14349]]],
    entrances: [[-70.95281, 43.14359]]
  },
  // UNH's 2 Leavitt Lane, once Human Resources', on UNH's list of buildings to close (unh.edu/leadership/blog, Oct
  // 2025). OpenStreetMap's way 79057128, which it addresses 2 Leavitt Lane, its outline as the extract of 18 Oct 2026
  // draws it
  {
    name:      "2 Leavitt Lane",
    kind:      "building",
    at:        [-70.95321, 43.14397],
    extent:    [-70.95344, 43.14385, -70.95299, 43.14408],
    outline:   [[[-70.95344, 43.14398], [-70.95304, 43.14385], [-70.95299, 43.14394], [-70.95299, 43.14394], [-70.95299, 43.14395], [-70.953, 43.14396], [-70.95301, 43.14397], [-70.95338, 43.14408]]]
  },
  // UNH's 6 Leavitt Lane, Facilities' visitor address (unh.edu/facilities/about/visit-us). OpenStreetMap's way
  // 28323288, which it addresses 6 Leavitt Lane and calls Central Receiving too, its outline as the extract of 18 Oct
  // 2026 draws it
  {
    name:      "6 Leavitt Lane",
    kind:      "building",
    at:        [-70.95355, 43.14349],
    extent:    [-70.95397, 43.14315, -70.95313, 43.14379],
    outline:   [[[-70.95397, 43.14333], [-70.95382, 43.14359], [-70.95381, 43.14359], [-70.9537, 43.14379], [-70.95349, 43.14372], [-70.95348, 43.14374], [-70.95313, 43.14363], [-70.95324, 43.14345], [-70.95331, 43.14347], [-70.95333, 43.14344], [-70.95326, 43.14342], [-70.95342, 43.14315], [-70.9536, 43.14321], [-70.95368, 43.14323], [-70.95363, 43.14331], [-70.95356, 43.14329], [-70.95345, 43.14348], [-70.95339, 43.14346], [-70.95337, 43.14349], [-70.95372, 43.1436], [-70.95373, 43.14357], [-70.95362, 43.14354], [-70.95374, 43.14335], [-70.95368, 43.14333], [-70.95373, 43.14325]]]
  },
  // The Durham–UNH station on Main St by the tracks, the old East Lynn depot, whose waiting room is the Amtrak station
  // and whose café is UNH's Dairy Bar (library.unh.edu archives' dining facilities, Wikipedia's Durham–UNH station).
  // OpenStreetMap's way 28762100, the building=train_station UNH operates, beside its Durham station and Dairy Bar
  // points, its outline as the extract of 18 Oct 2026 draws it
  {
    name:      "Dairy Bar and Durham Train Station",
    kind:      "building",
    at:        [-70.93612, 43.13935],
    extent:    [-70.93623, 43.13913, -70.93602, 43.13959],
    outline:   [[[-70.93623, 43.13914], [-70.93617, 43.13913], [-70.93614, 43.13925], [-70.93606, 43.13924], [-70.93602, 43.13937], [-70.93604, 43.13938], [-70.93603, 43.13945], [-70.93609, 43.13946], [-70.93606, 43.13958], [-70.93613, 43.13959]]]
  },
  // UNH's Fairchild Dairy, 36 O'Kane Rd (colsa.unh.edu/facility/fairchild-dairy-teaching-research-center).
  // OpenStreetMap's relation 1189415, the barn round a courtyard that's the largest building in the farmyard it names
  // the center and addresses 36 O'Kane Rd, its outline as the extract of 18 Oct 2026 draws it
  {
    name:      "Fairchild Dairy Teaching and Research Center",
    kind:      "building",
    at:        [-70.95248, 43.14642],
    extent:    [-70.95318, 43.14601, -70.95178, 43.14683],
    outline:   [[[-70.95246, 43.1464], [-70.95242, 43.14645], [-70.95207, 43.14633], [-70.9521, 43.14629]], [[-70.95243, 43.14656], [-70.9525, 43.14658], [-70.95256, 43.14649], [-70.95249, 43.14647], [-70.95252, 43.14643], [-70.95293, 43.14657], [-70.95301, 43.14645], [-70.9526, 43.14631], [-70.9527, 43.14615], [-70.95311, 43.14628], [-70.95318, 43.14617], [-70.95273, 43.14602], [-70.95273, 43.14603], [-70.95269, 43.14601], [-70.95264, 43.14609], [-70.95268, 43.14611], [-70.95256, 43.1463], [-70.9522, 43.14618], [-70.95226, 43.14608], [-70.95217, 43.14605], [-70.9521, 43.14615], [-70.95201, 43.14611], [-70.95194, 43.14623], [-70.95206, 43.14627], [-70.95203, 43.14633], [-70.95185, 43.14627], [-70.95178, 43.14638], [-70.95192, 43.14642], [-70.95194, 43.14639], [-70.95239, 43.14655], [-70.95236, 43.1466], [-70.95209, 43.14651], [-70.952, 43.14664], [-70.95255, 43.14683], [-70.95264, 43.14669], [-70.9524, 43.14661]]]
  },
  // UNH's wind tunnel on Waterworks Rd, "a rectangular box, 300 feet long by 20 feet wide" (unh.edu/unhtoday/node/5695,
  // ceps.unh.edu/facility/flow-physics-facility). OpenStreetMap's way 81341238, the long, narrow building=service off
  // Waterworks Rd past the water treatment plant, the one building there of that shape, its outline as the extract of
  // 18 Oct 2026 draws it
  {
    name:      "Flow Physics Facility",
    kind:      "building",
    at:        [-70.9393, 43.13259],
    extent:    [-70.93983, 43.13243, -70.93886, 43.13278],
    outline:   [[[-70.93983, 43.13253], [-70.93977, 43.13243], [-70.9391, 43.13262], [-70.93901, 43.13245], [-70.93886, 43.1325], [-70.93892, 43.13262], [-70.93901, 43.13278]]]
  },
  // UNH's Jackson Estuarine Lab at Adams Point (library.unh.edu archives' academic buildings, marine.unh.edu).
  // OpenStreetMap names it, as way 83699427 at 85 Adams Point Rd, but it's east of the box a generation reads (DURHAM
  // in scripts/map/osm.mts), so it's added here for good; its outline as the extract of 18 Oct 2026 draws it
  {
    name:      "Jackson Estuarine Laboratory",
    kind:      "building",
    at:        [-70.865, 43.09227],
    extent:    [-70.86518, 43.0921, -70.86487, 43.09245],
    outline:   [[[-70.86518, 43.09226], [-70.86518, 43.09225], [-70.86511, 43.09215], [-70.86503, 43.09217], [-70.86498, 43.09217], [-70.86497, 43.0921], [-70.86488, 43.0921], [-70.8649, 43.09219], [-70.86487, 43.09219], [-70.86493, 43.09245], [-70.86508, 43.09244], [-70.86505, 43.0923]]]
  },
  // UNH's NHVDL, 21 Botanical Lane (colsa.unh.edu), one story of about 6,500 sq ft "next to the greenhouses", as
  // Durham's planning board heard it (durhamnh.gov/1168). OpenStreetMap's way 1194320898, the unnamed building of about
  // that size just west of the greenhouses on Botanical Lane, its outline as the extract of 18 Oct 2026 draws it
  {
    name:      "New Hampshire Veterinary Diagnostic Laboratory",
    kind:      "building",
    at:        [-70.94026, 43.14089],
    extent:    [-70.94043, 43.14072, -70.94008, 43.14107],
    outline:   [[[-70.94043, 43.14079], [-70.94038, 43.14088], [-70.9404, 43.14088], [-70.94035, 43.14097], [-70.94033, 43.14097], [-70.94028, 43.14107], [-70.94008, 43.14101], [-70.94017, 43.14085], [-70.94014, 43.14084], [-70.94015, 43.14081], [-70.9402, 43.14072]]]
  },
  // UNH's observatory, 16 Spinney Lane by Boulder Field (ceps.unh.edu/physics-astronomy/unh-observatory). OpenStreetMap
  // names the site, a man_made=observatory, which isn't a kind of place the gazetteer keeps; this is its dome, way
  // 28911818, its outline as the extract of 18 Oct 2026 draws it
  {
    name:      "UNH Observatory",
    kind:      "building",
    at:        [-70.94418, 43.147],
    extent:    [-70.9442, 43.14698, -70.94415, 43.14702],
    outline:   [[[-70.94418, 43.14698], [-70.94417, 43.14698], [-70.94416, 43.14698], [-70.94416, 43.14698], [-70.94415, 43.14699], [-70.94415, 43.147], [-70.94415, 43.147], [-70.94415, 43.14701], [-70.94416, 43.14702], [-70.94417, 43.14702], [-70.94418, 43.14702], [-70.94419, 43.14702], [-70.9442, 43.14701], [-70.9442, 43.14701], [-70.9442, 43.147], [-70.9442, 43.14699], [-70.9442, 43.14699], [-70.94419, 43.14698]]]
  }
]

// Places OpenStreetMap misspells or calls by an old name, by that name, as their owners name them. Each is renamed
// only while a generation still has the wrong name, so one fixed upstream drops out here without a change; the
// old names stay searchable (ALIASES in src/social/aliases.mts)
export const RENAMED: Record<string, string> = {
  // As UNH's Library Archives spell them (library.unh.edu/find/archives/buildings), Housing Engelhardt
  // (unh.edu/housing/facility/engelhardt-hall-lower-quad) and the Alumni Association Elliott (alumni.unh.edu/about-us).
  // Ritzman is the Archives' Ritzman Animal Nutrition Lab, its laboratory spelled out
  "Morill Hall":                     "Morrill Hall",
  "Englehardt Hall":                 "Engelhardt Hall",
  "Ritzman Labatory":                "Ritzman Laboratory",
  "Elliot Alumni Center":            "Elliott Alumni Center",
  // 268 Mast Rd, New Hampshire Public Broadcasting's own since 2012 (Durham's assessor, gis.vgsi.com/durhamnh,
  // parcel 103203), and its studios, the NHPBS Broadcast Center, as it has been since New Hampshire Public
  // Television became New Hampshire PBS in 2017 (Wikipedia's New Hampshire PBS)
  "New Hampshire Public Television": "NHPBS Broadcast Center"
}

/**
 * Some places with those misnamed renamed and the added ones a generation doesn't name yet, in the gazetteer's
 * order by name
 */
export const withAdded = (places: readonly GazetteerPlace[]) => {
  const renamed = places.map(place => Object.hasOwn(RENAMED, place.name) ? { ...place, name: RENAMED[place.name] } : place)
  const named = new Set(renamed.map(place => place.name))
  const missing = ADDED.filter(place => !named.has(place.name))
  return [...renamed, ...missing].sort((a, b) => a.name.localeCompare(b.name, "en"))
}
