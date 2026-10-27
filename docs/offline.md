# Offline first, updated live

Every page opens from cache, code and data both, and the service worker (`src/sw/`, built to `/sw.js`) checks the network behind it. New data swaps in live; new code reloads the page quietly while it's out of view. No prompts.

## A page's head is its release manifest

`src/shell/manifest.mts` reads a page's `<head>` into a `Build`, which page and worker both go by:

- `<meta name="release">` is when it was built, `<meta name="published">` when it was published again, as a rollback is. Releases are ordered by the later.
- Its code: scripts, stylesheets, icons, the web manifest, and code loaded later (MapLibre's worker, PostHog), which `vite.config.mts` adds as prefetches by following dynamic imports. Every npm package is its own chunk, so an app change leaves MapLibre cached.
- A link per bundled JSON file, by `data-name`, hashed like code, so the HTML says exactly which code and data a page is. A script after them fetches each during parsing, and the first load takes that response (`src/shell/load.mts`); not preloads, as Safari never hands a preload to `fetch()`.

Absolute URLs (canonical, `og:image`) aren't part of a build, so the worker neither stages nor keeps them.

## Loading data

Pages read data through `latest(name, schema)` (`src/shell/build.mts`), a reactive slot that swaps in whatever file the newest build names once it's loaded. Immutable files load through `loadImmutable` (`src/shell/load.mts`):

- A file failing its schema is a failed load. Schemas check shape and provenance, and trust big arrays of our own making.
- A load is abandoned after a minute, and retried after 5 s, 15 s, 1 min, then every 5 min, and at once on coming back into view, until it loads or isn't wanted. Retries use `cache: "reload"`, which the worker honors, so a bad cached copy is replaced.
- A page waits for its slots' first loads; one with a fallback (the map's model) starts with it if the first try fails.

**What may mix.** Files from different builds meet in a page, so each pair either matches within one file or joins only by what lasts:

| Pair | Rule |
|---|---|
| A file and the code reading it | Must match: its schema, and the model's `version`, are checked on load |
| Style and its sprite and fonts | Must match: one folder named by their hash |
| Dining, courses and prerequisites indexes and their files (programs included); tiles manifest and its folder | Must match: named by content |
| Timetable and model | May mix, by stop and route ids. A route keeping its id through a new path keeps its old times until relearned |
| Timetable, walk network, gazetteer, places, tiles, events, parking areas | May mix, by coordinates and gazetteer names |
| Style and tiles | May mix, by layer name: a renamed campus layer draws nothing until matching tiles arrive |

## Taking in a newer release

The worker serves a page from cache and fetches it behind. A newer copy is **staged**, and promoted only once everything it names is kept:

- every file the head names, and every `required` file its data asks for (the map's `style.json`);
- each is what its name says (`isKeepable`): `.js`, `.css` and `.json` answer as such, and nothing hashed answers as HTML, so a sign-in page answering 200 at a hashed URL is served but never kept;
- each arrives whole within a minute, or the release is abandoned.

Then open windows are told. If only data differs, each changed file loads into its slot, keeping the trip, page, and camera; tiles and style update in place. If code differs, `src/shell/lifecycle.mts` reloads the page next time it's out of view and not busy (riding a bus sets `isBusy`), or at once if it already is. State in `src/shell/state.mts` survives the reload.

Pages also check on coming back into view and every 15 minutes in view. After an hour away a page starts fresh. A copy published before the one kept, as from a lagging edge, is ignored, which is why rolling back means publishing again ([deploying.md](deploying.md#rolling-back)).

`src/sw/worker.mts` keeps two contracts apart: **answering is best effort** about the cache (a failed put, full quota, or cache that won't open never fails a response), and **staging is strict** (anything that can't be kept, or answers as the wrong kind, keeps the release out). A write whose body stalls is abandoned at one minute, so neither holds up the other.

## Retention

One Cache Storage cache keeps the closure of every generation in use, and nothing else (`src/sw/retention.mts`):

- each cached page's current and previous copy;
- whatever open windows say they run, via a `MessageChannel` census with a second to answer;
- what each generation's data asks for through `Retain = { required?, files?, folders? }`. The worker knows nothing else of the data.

Writes and prunes share one queue, so nothing is kept mid-prune. Pruning runs after a newer page is kept, on activation, and when the quota is hit. There's no LRU or byte cap: the worker keeps only pages, `/assets/`, `/data/` and icons, about 14 MB with two generations per page, against a 1 GiB floor quota.

On `QuotaExceededError` a put climbs a ladder (`SURRENDERABLE`): prune, then drop all tiles, then the style's fonts and sprites, each rung once per storm (until a put succeeds or a page is taken in), and past the top answers uncached. Pages, what they name, and the style JSON are never surrendered.

The cache name (`app-v2`) changes when what it keeps changes meaning; activation deletes older caches but `reminders-v1` ([reminders.md](reminders.md)). If an open tab's hashed file is gone (404, or offline with no copy), the worker reloads that tab once, since old code can't recover by itself; a page that answers the census retries its own files instead.

Behind the worker, pages are fetched `cache: "no-cache"`, and hashed assets are immutable (`public/_headers`). The worker shares an in-flight download between a page and its staging, as Safari would otherwise download it twice. Live data (`/api/*`, Umo, other origins) bypasses the worker. Usage events (`src/shell/usage.tsx`) go straight to PostHog; those made offline are lost if the page closes first.

## Old tabs and the origin

What's promised is a count of generations, not a span of time:

- **Browser**: each page's current and previous copy, plus whatever open windows report. A frozen or back-forward-cached window is covered only back to its page's previous generation.
- **Origin**: the current and previous build's tile and style folders; dining, course and prerequisite files per [storage.md](storage.md).

So two quick releases can leave a tab two generations behind, its uncached files 404ing until it reloads. That's accepted.

## iOS and Safari

- Safari deletes a site's script-writable storage after seven days of use without a visit; Home Screen apps are exempt. Pages then load as a first visit, and synced things come back from the Worker ([storage.md](storage.md#your-things-kept-for-you)).
- iOS 16.4 gives an origin about 1 GiB; Safari 17+ about 60 % of disk, 15 % in other apps' web views. Past the overall quota Safari evicts whole origins, least recently used first.

## Tests

- `tests/shell/sw.test.mts`: the worker against an in-memory world, with a named regression for each sequence that once broke it.
- `tests/shell/sw.model.test.mts`: against a model over generated sequences of releases, windows, offline, full quotas, sign-in pages, stalls, restarts, and frozen windows.
- `npm run test:browser` (`tests/browser/sw.browser.mts`): release sequences in Chromium and WebKit, including a rollback and an upgrade from a real earlier release built from its own commit.
