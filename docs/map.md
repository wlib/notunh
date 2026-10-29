# Map

The map's sheet, and what it takes from OpenStreetMap. Buses are in [transit.md](transit.md).

## The sheet

- **Home** (`src/map/ui/Home.tsx`): search (`ui/Search.tsx`), You and Directions over the week as one list: Yours (next saved class, reminders, saved trips), Now, Later today ending in "+ New event", then the days to come. Typed searches lay suggestions over the week, still mounted.
- **Pages** (`link.mts`, `state/page.mts`, `ui/Pages.tsx`): every other view is a shareable path in history, `/map/<kind>/<what>`, spaces as `+`, its scroll kept for Back. Besides those in [courses.md](courses.md), [programs.md](programs.md), [parking.md](parking.md) and [social.md](social.md): `place/<name>`, `stop/<id>`, `bus/<vehicle>`, `buses`, `directions`, `new[/<place>]` and `you` (`#link=`, `#verify=` open it). `?to=<place>`, `laundry/<room>` or `dining/<hall>` plans a trip and opens Directions.
- **Detents** (`ui/sheet.mts`): lowered, half, tall, each a fixed height, any page. Only a drag, the grabber, or something new raising a lowered sheet moves it.
- **Camera**: `followPage` (`render/map.mts`) alone drives it, easing once as a page opens and again only when its target changes (`aimed`, `render/camera.mts`); Directions' target is the whole trip. Views mark their place with `state.focusAt(page, spot)`, written only while that page is shown. bruh runs a detached node's effects till it's collected: keep side effects out of reactive JSX.
- **Taps** (`render/taps.mts`): a stop or bus opens its page; elsewhere is the trip's end.

## Map data

`.github/workflows/map.yml` downloads Geofabrik's New Hampshire extract each Monday, and `scripts/map/osm.mts` (on `@osmix/pbf`, `scripts/map/pbf.mts`) makes one generation:

- `src/map/walk.json`: the walking network around Durham;
- `src/map/gazetteer.json`: every named place, with kind, middle, extent, and buildings' outlines and doors;
- `src/map/parking.json`: OSM's parking areas, for parking's nightly check;
- vector tiles by [Planetiler](https://github.com/onthegomap/planetiler) (`scripts/map/tiles.mts`).

Its version is `<extract date>-<generator8>`, hashing the generating code, `campus.yml`, locked packages and Planetiler (`src/shared/made.mts`). It's published as the immutable release `map-data-<version>`, then `latest.json` on `map-data` moves to it (`scripts/release.mts`). A build installs its pinned generation whole, hashes checked (`installMapData` in `scripts/inputs.mts`), and fails without one; only offline builds use the fixtures. Locally (Java 21+): `node scripts/map/osm.mts <extract.osm.pbf> <planetiler.jar> [--release <folder>]`.

## Tiles and base map

Two tile sets (`src/map/basemap/tiles.mts`), at `public/data/map/tiles/<version>/<set>/{z}/{x}/{y}.pbf`, each exactly the tiles inside its boxes, with an empty file where Planetiler made none:

- **base**: OpenMapTiles, zooms 10 to 14 around Durham, Dover and Portsmouth;
- **campus**: our schema (`scripts/map/campus.yml`), zooms 14 to 16: building names, parking, doors, benches, emergency phones, water, fences, trees.

The `tiles://` protocol serves ours where a set covers, else OpenFreeMap's pinned planet build, so tiles meet without a seam. They're stored uncompressed (gzip saves a quarter, and MapLibre needs `Content-Encoding` for it); Cloudflare compresses in transit.

OpenFreeMap's Liberty style is restyled nightly (`scripts/map/style.mts`, `src/map/basemap/style.mts`) into a folder under `public/data/map/` named by its hash, which `src/map/style.json` names and which is kept one build after (`keepServedStyle`). Sprite, Latin and Greek glyphs are ours (`GLYPH_RANGES`), rarer glyphs OpenFreeMap's. Campus layers are added, hidden detail redrawn, and unnamed flowerbeds, barriers and OSM bus stops left out.

## Walking

`src/routing/graph.mts`, `walks.mts`. The network keeps each connected part of OSM's paths with twenty or more paths. A walk ends at a building's nearest door where the gazetteer knows doors. Where the network doesn't join both ends, the walk is an **estimate**, a dashed straight line, allowed 30 % over its time at 1.3 m/s against 10 % for a network walk.

## Places

- **Search** (`src/places/search.mts`, uFuzzy): gazetteer, stops, laundry and dining buildings, each name once, nearest the middle of campus, and by its aliases too, an exact one first; Greek letters are spelled out, so "ΣΧ" is "Sigma Chi". [Photon](https://photon.komoot.io) for addresses or when little is found. The home adds rooms to book ([courses.md](courses.md#rooms-to-book)), instructors, sections, rooms, parking, events, programs and the chapters the map doesn't place (`ui/Search.tsx`).
- **A tapped spot** is named by the map's label, the building it's in or a place within 60 m, the tiles' house number, else Photon (`src/places/gazetteer.mts`).
- **Unnamed in OSM**: `src/places/added.mts` names them (HSSC) until a generation does.
- **Fraternities and sororities** (`src/places/chapters.mts`): the chapters UNH recognizes, reviewed by hand against its chapter scorecards and Wildcat Link, as they change a few times a decade; a fetch would add a parser for one page to save a few edits. Each has its letters, council, designation, UNH's page, nicknames (each confirmed by a source, said beside it) and its house: the address and spot from Durham's parcels (the town's `Parcels_Current` layer on ArcGIS Online, whose fraternity and sorority parcels name the chapter or its house corporation) and the OSM building inside the parcel. A placed house joins the gazetteer under the chapter's name, as `kind: "building"` so taps, doors and walks treat it as one, taking the outline and doors of the building it's in in place of whatever OSM calls it, and is searched by its letters and nicknames, marked on the map (columns, white on indigo for a fraternity, plum on white for a sorority) and labelled by its letters from zoom 15.5, Greek glyphs bundled with the style; its page says its letters, chapter and council, and links to UNH's page. A chapter without a placed house is searched as its own group, saying so. To update: compare the scorecards and Wildcat Link with the list; for a new house, find its parcel on Durham's map and the building in it, and copy that building's middle as `at`.
- **Reserving and borrowing** (`src/places/services.mts`): the few ways to reserve or borrow something that belong to one place and aren't a room to book, each a line among the place's page's links: Hamel's racquetball and squash courts (`crec.unh.edu/booking`) and the library's equipment at Dimond's Info Desk. Kept by hand and short: only where it's how it's done there, never a building's list of offices.
- **Laundry and dining buildings** match gazetteer buildings into `src/map/places.json` (`scripts/map/places.mts`): laundry rooms by hall name, with a small alias table, as the vendor puts every room at one spot. An unmatched one fails the build.
