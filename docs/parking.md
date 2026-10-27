# Parking: a stay, not an instant

Where someone can park for as long as they'll be there. The answer has four inputs, **arrive, leave, permit and purpose**, says only what UNH's sources say for certain, and links to UNH's pages for the rest. See [storage.md](storage.md) for what's kept.

## The areas

An **area** is the smallest place with a rule of its own (`Area` in `src/parking/model.mts`): a lot, its meter spaces, or A Lot's rear sections, so B Lot and its meters are two areas, as are A Lot and sections 3 and 4. The rules are kept by hand in `src/parking/areas.mts`, from the parking map's key, the pay-per-hour table, the policies page and the visitor page.

Each night `scripts/map/parking.mts` checks them against what a machine can read (`src/parking/sources.mts`): UNH's zone table (the PDF the visitor page links, read as text), ParkMobile's zones, and OSM's parking areas from the weekly map data (`src/map/parking.json`, or the extract for map data made before it). It writes `src/parking/parking.json`; any disagreement fails the night. An area's spaces are OSM's `capacity` where every outline it names has one. Pages show the oldest source's time as "checked".

An area whose point is placed by eye is `guessed`: its walk says "approx.", and no route starts there.

## The verdict

`fits(area, who, stay, holidays)` judges the whole stay. Every clock boundary any rule names, on each day the stay touches, cuts it into **segments**, each free, pay, permit (yours), closed or unknown, with a reason. The verdict is "no" at the first closed segment or once paid time runs past one payment's maximum, "unknown" at the first unknown segment, else "yes", with the paid hours and their cost. The reason names no time of the stay; its `from` says when it bites ("Permit required from 7 AM"), and `nextChange` what comes next ("open from 6 PM").

Whether the stay fits, when it costs money, and whether it can be known are kept apart:

- **Holidays** are UNH's, from the courses index's calendar (`coursesIndex.calendar.holidays`). On them UNH checks no permits and meters are free.
- **Purpose** matters at Thompson Hall's lot, for short errands ("Do not park there for attending class", the visitor page says). It refuses a class, an event or a visit in words.
- **Winter** is said only as far as it's certain. The winter page, its grid of lots and the policies page agree the ban runs midnight to 6, daytime rules resuming at 7, on nights from 1 January to 1 April, "adjusted with public announcement"; one paragraph of the visitor page says from 1 December. Which lots stay open differs between the winter page and its grid (Strafford in a snow emergency, Mast Road and Mathes on a standard night), and snow emergencies are declared by phone nightly. So from 1 December to 1 April, midnight to 7, a segment is "unknown, winter ban may apply", linking [UNH's winter page](https://www.unh.edu/transportation/parking/information/winter-parking-ban). Still certain: a lot closed by its ordinary rules is closed, and the resident lots both the page and its grid keep open to permit holders all night (E, E1, E2, Gables, Woodsides; `winter: "permit-holders"`) are theirs. There is no snow toggle. Which start date is right is open.
- **The town's lots** (Depot Road, Pettee Brook, Main Street) are left out: their rates step up by the hour and cap by the day ($18 at Depot Road) in ways these rules can't say. The sheet links the [town's parking page](https://www.durhamnh.gov/605/Visitor-Parking-Information-Map).

## On the map

A ranked list and inspectable pages, with no map tinting and no chosen lot (`src/map/ui/Parking.tsx`, `src/map/state/parking.mts`).

- **Parking near a place**, `/map/parking/Kingsbury+Hall?arrive=2026-10-27T06:30&leave=2026-10-27T08:30&for=class` (Durham's clock; never `to=`, which plans a trip):
  - Arrive, Leave, Permit and For fold into one line ("Tue, Oct 27, 6:30 – 8:30 AM · no permit · a class · Change"), so the ranked areas lead the half-height sheet. Changing one changes the link in place.
  - The stay comes from a visit when there is one, from 30 minutes before it to 15 after its end, or two hours from its start; else now for two hours.
  - The best five areas, by whether the stay fits, then walk, then cost, each with the stay as a thin bar, the verdict in words, cost, walk, and Fits, No or Maybe. Below them at most one explanatory "No": the nearest area that doesn't fit, where nearer than one shown ("P Lot · Permit required from 7 AM · open from 6 PM · 2 min walk").
  - Reached from a place's, section's or event's page, Directions for a visit, and searching "parking". `/map/parking` with no place ranks every area without a walk.
- **An area**, `/map/area/B` with the same stay parameters: kind and spaces where known, your stay, the verdict with its reason and next change, and cost; "Winter ban may apply" on a winter night. Directions (never for a guessed area), Share, and "Pay · ParkMobile zone 98717", which opens ParkMobile's web app front page, where the zone is entered: no documented link fills it in (`/zone/start?zoneNumber=` didn't), so the number is on the button. The rules follow as lines in the order they bite (permit hours, paid hours, open or free hours, winter), then the areas within it.
- **Search**: a lot's name opens its area.
- **Your permit** is the Permit field, kept as `parking-permit`, synced per person like your other things.

Space availability is unknown, and posted signs win. Pages say they're not an official source.
