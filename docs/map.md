# Map data

What the map takes from OpenStreetMap, plus the base map, walking, and place search. Buses are in [transit.md](transit.md).

## One generation from one extract

The Map data workflow (`.github/workflows/map.yml`) downloads Geofabrik's New Hampshire extract each Monday, and `scripts/map/osm.mts` makes:

- `src/map/walk.json`: the walking network around Durham;
- `src/map/gazetteer.json`: every named place, with kind, middle, and extent, and each building's outline and doors;
- vector tiles, made with [Planetiler](https://github.com/onthegomap/planetiler) (`scripts/map/tiles.mts`).

The three are one generation. Each file is stamped (`src/shared/made.mts`) with the extract's date and a hash of the generating code, `campus.yml`, the locked package versions, and Planetiler's version, giving the version `<extract date>-<generator8>`. It's published whole as the immutable release `map-data-<version>`, then the `map-data` release's `latest.json` is moved to it (`scripts/release.mts`).

A build installs its pinned generation (`installMapData` in `scripts/inputs.mts`): all or nothing, hashes checked first. It fails if nothing is published. Only an offline build uses the fixtures' walk and gazetteer, with OpenFreeMap's tiles alone.

`scripts/map/pbf.mts` reads the extract in about 3 s on top of `@osmix/pbf`, and refuses a truncated file. To make a generation locally (Java 21+):

```sh
node scripts/map/osm.mts <extract.osm.pbf> <planetiler.jar> [--release <folder>]
```

## Tiles

Two sets (`src/map/basemap/tiles.mts`), served from `public/data/map/tiles/<version>/<set>/{z}/{x}/{y}.pbf`:

- **base**: the OpenMapTiles schema Liberty draws, zooms 10 to 14 around Durham, Dover, and Portsmouth;
- **campus**: our own schema (`scripts/map/campus.yml`), zooms 14 to 16 around Durham: building names, parking, doors, benches, emergency phones, water, fences, trees.

Each set is exactly the tiles wholly inside its boxes, with an empty file wherever Planetiler made none. The style names tiles `tiles://<set>/{z}/{x}/{y}`, and the map's `tiles` protocol fetches ours where the set covers, else OpenFreeMap's pinned planet build. So each tile is wholly ours or wholly theirs, and they meet without a seam.

Tiles are stored uncompressed: gzip saves only a quarter, and MapLibre can't read it without `Content-Encoding`. Cloudflare compresses them in transit.

## Base map

OpenFreeMap's Liberty style, restyled nightly with the inputs (`scripts/map/style.mts`, `src/map/basemap/style.mts`) into a folder under `public/data/map/` named by the hash of its contents, so style, sprite, and fonts always match. `src/map/style.json` names that folder.

- Sprite and the Latin and punctuation glyphs are served from our origin; rarer glyph ranges come from OpenFreeMap.
- Tile URLs point at ours where we have them, else at the planet build current when the style was acquired, so they never change under a running page.
- Campus layers are added, and layers that hide what the tiles have are redrawn. Unnamed flowerbeds, barriers, and OSM bus stops are left out.

The previously served style folder stays one more build (`keepServedStyle`).

## Walking

`src/routing/graph.mts`, `src/routing/walks.mts`. The network keeps every connected part of OSM's paths with twenty or more paths. A walk goes to and from a building's nearest door where the gazetteer knows its doors, else the place itself.

Where the network doesn't join both ends, the walk is an **estimate**: a straight line, drawn dashed. The planner allows it 30 % over its time at 1.3 m/s, against 10 % for a network walk.

## Places

- **Search** (`src/places/search.mts`): gazetteer, stops, and laundry and dining buildings, with uFuzzy. Each name appears once, as the place nearest the middle of campus. [Photon](https://photon.komoot.io) only for addresses, or when little is found locally.
- **Naming a tapped spot** (`src/places/gazetteer.mts`): the map's label, else the building it's in or a place within 60 m, else the tiles' house number, else Photon.
- **Laundry and dining buildings**: `scripts/map/places.mts` matches them to gazetteer buildings into `src/map/places.json`. The vendor puts every laundry room at the same spot, so rooms match halls by name, with a small alias table. An unmatched room or hall fails the build.

`/map/?to=laundry/<room>` or `?to=dining/<hall>` plans a trip there from your location.
