# Map data

Everything the map has of OpenStreetMap, plus the base map style, walking, and place search. Buses are in [transit.md](transit.md).

## One generation from one extract

The **Map data** workflow (`.github/workflows/map.yml`) downloads Geofabrik's New Hampshire extract each Monday, and `scripts/map/osm.mts` makes three things from it:

- `src/map/walk.json`: the walking network around Durham;
- `src/map/gazetteer.json`: every place OSM names, with its kind, middle, and extent, and each building's outline and doors;
- our own vector tiles, made with [Planetiler](https://github.com/onthegomap/planetiler) (`scripts/map/tiles.mts`).

The three are one **generation**, each file stamped with where it came from (`src/shared/made.mts`): the extract's date and a hash of the generating code, `campus.yml`, the packages it uses as `package-lock.json` resolves them, and Planetiler's version. Together those name the version, `<extract date>-<generator8>`. A generation is published whole as the immutable release `map-data-<version>` (one `map-data.tar.gz` and a manifest of hashes), then `latest.json` on the `map-data` release is moved to point at it (`scripts/map/release.mts`). A build takes all of a generation or fails; hashes are checked before anything is swapped in. A build only falls back (to the fixtures' walk and gazetteer and OpenFreeMap's tiles) on a 404 of `latest.json`, meaning nothing has been published yet.

The workflow publishes only when the pointer doesn't already name the generation, so the schedule and the Worker's Monday dispatch can both fire safely.

`scripts/map/pbf.mts` reads the extract in about 3 s. `@osmix/pbf` handles the file's framing, blocks, and protobuf; what OSM's fields mean and how elements are gathered are ours. A truncated file is refused rather than misread.

To make a generation locally (needs Java 21+):

```sh
node scripts/map/osm.mts <extract.osm.pbf> <planetiler.jar> [--release <folder>]
```

`npm run osm:refresh` takes the latest published generation instead.

## Tiles

Two sets (`src/map/basemap/tiles.mts`), served from `public/data/map/tiles/<version>/<set>/{z}/{x}/{y}.pbf`:

- **base**: the OpenMapTiles schema Liberty draws, zooms 10 to 14 around Durham, Dover, and Portsmouth;
- **campus**: a schema of our own (`scripts/map/campus.yml`), zooms 14 to 16 around Durham: building names, parking, doors, benches, emergency phones, drinking water, fences and walls, trees.

Each set is cut to exactly the tiles wholly inside its boxes, which stay in New Hampshire since the extract has nothing of Maine across the river. Where Planetiler made no tile there's an empty file, so every tile the map asks us for exists. The style names tiles as `tiles://<set>/{z}/{x}/{y}`, and the map's `tiles` protocol fetches each from us where the set covers it, else from upstream (OpenFreeMap's pinned planet build, for the base set), else none. So each tile is wholly ours or wholly OpenFreeMap's, and they meet without a seam.

Tiles are stored uncompressed: gzip only saves a quarter, and MapLibre can't read it without a `Content-Encoding` header. Cloudflare compresses them in transit. A version is about 1,200 files and 3.2 MB; the build keeps the previously served version beside the new one for open tabs, well within the free plan's 20,000 files per deploy.

## Base map

OpenFreeMap's Liberty style, made ours at build time (`scripts/map/style.mts`, `src/map/basemap/style.mts`) into a folder under `public/data/map/` named by a hash of everything in it, so style, sprite, and fonts always match. `src/map/style.json` names that folder and is bundled like other data.

- Sprite and the Latin and punctuation glyph ranges are served from our origin; rarer ranges still come from OpenFreeMap.
- Tile URLs point at ours where we have them, else at the planet build current at build time, so they never change under a running page.
- Our campus layers are added, and layers are redrawn where they hide what's in the tiles: house numbers, bicycle parking, ATMs, woods, railways and platforms, campus land use and pitches. Unnamed flowerbeds, barriers, and OSM bus stops (our own stops already show) are left out.

On the origin, the previously served style folder stays one more build beside the new one.

## Walking

`src/routing/graph.mts`, `src/routing/walks.mts`. The network keeps every connected part of OSM's paths with twenty or more paths. A walk goes to and from a building's nearest door where the gazetteer knows its doors, else the place itself, joining the network by the nearest few paths and letting the shortest way decide.

Where the network doesn't join both ends, the walk is an **estimate**: a straight line, drawn dashed and faint. The planner allows it 30 % more than its distance takes at 1.3 m/s, against 10 % for a walk along the network.

## Places

- **Search** (`src/places/search.mts`): the gazetteer, stops, and laundry and dining buildings first, with uFuzzy (as dining searches foods). Each name appears once, as the place by that name nearest the middle of campus. [Photon](https://photon.komoot.io) only for addresses, or when little is found locally.
- **Naming a tapped spot** (`src/places/gazetteer.mts`): the map's label there, else the gazetteer building it's in (by outline where known) or a place within 60 m, else the tiles' house number, else Photon.
- **Laundry and dining buildings**: `scripts/map/places.mts` matches them to campus buildings in the gazetteer, into `src/map/places.json`. The laundry vendor puts every room at the same spot, so rooms are matched to halls by name, with a small alias table where OSM names a building differently. An unmatched room or hall fails the build. `places.json` records a hash of its inputs (gazetteer, rooms, menus, code) and is derived again when any changes.

`/map/?to=laundry/<room>` or `?to=dining/<hall>`, as the laundry and dining pages link, plans a trip there from your location.
