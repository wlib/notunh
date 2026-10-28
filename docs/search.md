# Search

What notunh.app does so people find it for "unh map", "unh bus", "holloway menu", "unh laundry" and "unh events", and what the owner does by hand.

## What's done

- **Titles** say what people type: "UNH Bus Tracker & Campus Map: Live Wildcat Transit", "UNH Dining Menus Today: Holloway & Philbrook", "UNH Laundry: Free Washers & Dryers by Hall" (`src/shell/pages.mts`). A map page's title adds what it is unless it says UNH already: "McConnell Hall · UNH bus stop · notunh" (`CONTEXTS` in `worker/preview.mts`).
- **Bodies say something before any script.** The map's shell lists the routes and the week's events, each linking to its page; dining's lists today's menus by hall, meal and station, with hours; laundry's lists every room. All are made when the site's built, which a nightly build makes the morning they're served. On the map's pages and the laundry rooms', the Worker writes a summary in place of the shell (`src/map/site.mts`, `src/shell/summary.mts`): an event's when, where and calendar; a stop's buses for the next 4 hours by the timetable; a place's events, classrooms, laundry rooms, dining and chapter; a section's meetings and rooms; a course's sections; a program's courses. Its title is the page's one `h1`. The app replaces the whole `#app` as it loads, and the service worker keeps `/map/` as built, so a cached or offline page never shows a summary.
- **Canonical addresses**: each of the map's pages and each laundry room is its own; pages of nothing in particular (`/map/directions`, `/you`, `/new`, `/buses`, `/bus/…`) stay `/map/`'s.
- **Kept out of search**: instructors' pages and pins (`noindex` meta and `X-Robots-Tag`, no structured data, no body for instructors). A map path naming nothing there is (an unknown kind, an event gone) is the map answering **404** with `noindex`, so the app still opens. A page whose data can't be read is the map as built, 200. Other unknown paths are Cloudflare's 404.
- **Structured data**, only where Google shows something (`src/shell/structured.mts`): `WebSite` with `alternateName` ("not UNH", "notUNH", "notunh.app") and `Organization` with the logo on the home page; `BreadcrumbList` on every other page; `Event` on an official event placed in Durham, with offsets, address, status, attendance mode, image (its card), and organizer where its calendar has one. Never price, performer or anything not known. `WebApplication` was dropped: without ratings Google shows nothing for it.
- **Basics**: `robots.txt` blocks only `/api/`; no `hreflang` (one language); pages are mobile-first and their shells static, so the first paint is text.

## The sitemap

`scripts/search.mts`, after `vite build`, lists the 4 pages, every laundry room, and the map's pages `listedPages` gives as of the build (October 2026: about 10,500): official events not over, places with something on, classes, a laundry room, a hall or a chapter, every stop a bus picks up at, the courses, sections and rooms of terms not over, `/map/program` and each program, `/map/parking` and each area. Never `/map/person/…`. Over 50,000 it becomes an index of `/sitemaps/<n>.xml`.

Each page has a **fingerprint**: a hash of a static page's HTML without its release, of a map page's preview (what its head and card say), or of a room's name. `/sitemap.json` keeps each page's fingerprint and `lastmod`; a page keeps the served `lastmod` while its fingerprint matches, else takes the build's release. `postdeploy` (`scripts/indexnow.mts`) submits exactly those, 10,000 to a request: a night's new events and menus, not every page. The first deploy after this submits everything once, as nothing's served yet. An event leaves the sitemap the night after it ends.

## Owner checklist

1. **Google Search Console**: add the `notunh.app` Domain property (the `google-site-verification` TXT record is already in Cloudflare DNS), then Sitemaps → submit `https://notunh.app/sitemap.xml`.
2. **URL Inspection** → Test live URL, then Request indexing, for `/`, `/map/`, `/dining/`, `/laundry/`, one event, one stop and one place. Check the rendered HTML has the summary or the app, and the Event shows under Enhancements (or run it through the [Rich Results Test](https://search.google.com/test/rich-results)).
3. A week on: Pages report (watch "Duplicate, Google chose different canonical" and "Soft 404"), and Enhancements → Events and Breadcrumbs for errors.
4. **Bing Webmaster Tools**: Import from Google Search Console; IndexNow already reaches Bing.
5. **Links that matter** (the "nottingham bus" correction fades as people search for and link to notunh): a post on r/UNH; The New Hampshire (the student paper); clubs' Linktrees and Wildcat Link pages linking their events or the map; the GitHub README linking `https://notunh.app`. Descriptive anchors ("UNH bus tracker", "Holloway menu") beat "click here".
