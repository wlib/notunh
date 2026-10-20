# Offline first, updated live

Every page opens from the cache at once, code and data both, and the service worker (`src/sw/`, built to `/sw.js`) checks the network behind it. New data is swapped in live. New code reloads the page quietly while it's out of view. No prompts.

## A page's head is its release manifest

`src/shell/manifest.mts` reads a page's `<head>` into a `Build`, which both the page and the worker go by:

- `<meta name="release">`: when it was built. `<meta name="published">`: when it was published again, as a rollback is (`scripts/republish.mts`). Releases are ordered by the later of the two.
- Its code: scripts, stylesheets, icons, the web manifest, and maplibre's worker. `vite.config.mts` names maplibre's worker in the head, since only the code that starts it knows its URL.
- A preload link per bundled JSON file, by name (`data-name`): the map's timetable, model, walk network, gazetteer, tiles, style, and places; the dining index; the laundry rooms' usual weeks. Vite hashes them like code, so the HTML says exactly which code and which data a page is.

Every npm package builds into its own chunk, so a change to the app leaves maplibre cached.

## Loading data: one slot per file

Pages read data through `latest(name, schema)` (`src/shell/build.mts`), a reactive value everything derived from it follows.

- **Files join only by stable ids and coordinates**: the timetable's stop and route ids, the model's, the gazetteer's and places' positions, the dining index's content-named children. So any build's file goes with any other's, nothing is swapped in as a group, and whatever is derived from several files is derived again from whichever are newest.
- A file that doesn't fit its schema is a failed load. The schema checks shape and provenance but takes big arrays of our own making on trust.
- A failed load is retried after 5 s, 15 s, 1 min, then every 5 min, and at once when something newer is named. Retries bypass every cache (`cache: "reload"`, which the worker honors too), so a file that once answered as the wrong thing isn't read back from the cache forever.
- A load that hangs is given up on after a minute, so it holds up no other.

## Taking in a newer release

The worker serves a page from cache and fetches it behind. A newer copy is **staged**, and promoted only once everything it names is confirmed kept:

- every file the head names, and every `required` file its data asks for (the map's `style.json`);
- each file is what its name says (`isKeepable`): a `.js`, `.css`, or `.json` must answer as one, and nothing hashed may answer as an HTML page. A sign-in page answering 200 at a hashed URL is served but never kept;
- each arrives whole within a minute, or the release is abandoned and its siblings cancelled.

Then the page's open windows are told. If only data differs, each changed file loads into its slot, keeping the trip, the chosen itinerary, the selected stop, and the camera. A newer tiles week replaces the old in place; a newer style is applied as a diff. If code differs, `src/shell/lifecycle.mts` reloads the page the next time it's out of view and not busy (riding a bus sets `isBusy`), or at once if it already is. What a page remembers between visits (`src/shell/state.mts`, like the trip being planned) survives the reload.

Pages also ask for a check when they come back into view and every 15 minutes in view, so a window that never navigates still hears of the nightly build. After an hour away a page starts fresh. A copy published *before* the one kept, as from an edge not yet caught up, is ignored by worker and page alike. That's why rolling back means publishing again (see the README).

Two contracts are kept apart in `src/sw/worker.mts`:
- **Answering a request is best effort about the cache.** A failed put, a full quota, or a cache that won't open never fails a response.
- **Staging a release is strict.** Anything that can't be kept, or answers as the wrong kind, keeps the release out.

Neither holds up the other for long: a write whose body stalls is abandoned at a one-minute deadline.

## Retention

The worker keeps one Cache Storage cache. What it keeps is **the closure of every generation in use**, and nothing else (`src/sw/retention.mts`):

- each cached page's current and previous copy;
- whatever the open windows say they run, asked over a `MessageChannel` census with a second to answer;
- what each generation's data asks for through `Retain = { required?, files?, folders? }`: the style manifest requires its `style.json`; the dining index names its `files` (kept if present, loaded as opened); the tiles and style manifests name their `folders`. The worker knows nothing else of any of them.

Every cache write and every prune takes its turn on one queue, so nothing is kept mid-prune and no page's files are mistaken for another's leftovers. Pruning runs after a newer page is kept, on activation, and when the quota is hit.

**No LRU, LFU, or byte cap.** What a browser can store is bounded by what's published, since the worker only keeps pages, `/assets/`, `/data/`, and the icons: about 14 MB with two generations per page, against a 1 GiB floor quota. A frequency policy would never act and would cost a write per hit.

**On `QuotaExceededError`** a put climbs a ladder (`SURRENDERABLE` in `src/sw/worker.mts`): prune, then drop all tiles, then the style's fonts and sprites. Each rung runs once per storm, which lasts until a put succeeds or a page is next taken in; puts failing together share a rung rather than each climbing one. Past the top it answers from the network uncached. Pages, what they name, and the style JSON are never surrendered.

The cache name (`app-v2`) changes when what it keeps changes meaning, and activation deletes older caches. Pages from the `app-v1` worker named only their code and loaded data by URL, so what they need can't be told: they're fetched fresh like an unvisited page. If an open tab's hashed file is gone (404, or offline with no copy), the worker navigates that tab afresh once, since old code can't recover by itself; a page that answers the census retries its own files instead.

The HTTP cache sits behind the worker. Pages are fetched with `cache: "no-cache"`, so HTML is always the edge's; hashed assets are immutable by name. Live data (`/api/*`, Umo, other origins) bypasses the worker entirely.

## Old tabs and the origin

A tab on last night's release may ask for files the origin no longer has. The origin keeps the generation before the current one for this: the tiles' and style's folders for one more build, and dining files one build and 48 h past the last index naming them (see [storage.md](storage.md)). A window that can't answer the census (frozen, or in the back-forward cache) is covered as far back as its page's previous generation. Older than that, it 404s on uncached files (MapLibre draws without that glyph range or sprite) until it reloads: once out of view after a newer build is announced, or at once after an hour away.

## iOS and Safari

- **Seven-day rule.** Safari deletes all of a site's script-writable storage (caches, the service worker, `localStorage`) after seven days of Safari use without visiting it. Home-screen apps are exempt. Pages then load as a first visit and are cached again.
- **Quota.** iOS 16.4 (the floor) gives an origin about 1 GiB; Safari 17+ about 60 % of disk, 15 % in other apps' web views. Past the origin's quota, puts throw `QuotaExceededError` (the ladder above). Past the overall quota Safari evicts whole origins, least recently used first, which nothing here can prevent.
- `DecompressionStream` handles gzip on 16.4, which is why nothing a page reads is zstd.

## Tests

- `tests/shell/sw.test.mts` drives the worker against an in-memory world, with named regressions for each sequence that once broke it.
- `tests/shell/sw.model.test.mts` runs it against a model over generated sequences: releases, windows, going offline, quotas full for every file or only large ones, a sign-in page answering for a data file, the network stalling a page's files, restarts, the worker killed mid-staging, and frozen windows.
- `npm run test:browser` runs the release sequences through Chromium and WebKit (`tests/browser/`): a data-only release shown live, a worker change taking over an open tab, and a rollback from release C to A.
