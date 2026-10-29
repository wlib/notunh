# Courses: where a class is, and when

Classes, instructors and rooms on the map, from the registrar's course API (`wapi.unh.edu/dhub`, what courses.unh.edu reads) and 25Live's academic calendar. Nothing here is enrolment: a class is a place and a time to get to, like an event. See [storage.md](storage.md) for what's kept and [reminders.md](reminders.md) for class reminders.

## The nouns

The sources keep these apart, and so does `src/courses/course.mts`:

- A **course** is the catalog's "CS 518". Its page lists what it needs and unlocks ([programs.md](programs.md)), the programs naming it, and its sections each term.
- A **section** is a term's offering: a CRN, a title, instructors and meeting patterns. Its page leads with the next meeting.
- A **meeting pattern** is days, a time, dates and a room; CS 518 meets in N343 Tuesday and Thursday and N113 Friday, so a section is never one event at one place. A pattern is a line on the section's page.
- A **dated meeting** is a pattern on one day, the only thing with a start, end and place. It projects to the event shape (`CourseEvent`), so it lists, routes and reminds like one. Its id is keyed by what the meeting is (days, start, room, first date), so a refetch that reorders a section changes nothing saved.
- An **instructor** (`people.mts`) is keyed by the hidden address where the registrar gives one, else the name. Their page says scheduled teaching, never whereabouts or office hours: the next class across every section they're on in a live term, and the week.
- A **room** (`rooms.mts`) is the registrar's text, "Kingsbury N343", indexed with its building. Its page is today's schedule there; it says a room is free only where 25Live books it too ([Rooms to book](#rooms-to-book)).

`standing(term, section, calendar, now)` gives the meeting under way and the next, whatever order the source lists meetings in. No-class days, swap days (a Tuesday run as a Wednesday) and holidays come from 25Live's all-day entries by their titles' pattern (`calendar.mts`), which `scripts/map/courses.mts` prints for a person to check once a term.

## Terms

Terms are a set, never "the" term. The pipeline publishes every term running or starting within 150 days that has sections; pages load the **live** ones, running or starting within two weeks (`activeTerms`), so in late January J-Term and Spring, and the terms to come only for a course's page. Saved sections are keyed `term:CRN` (`202610:12496`) and read against the live terms, so a past term drops out by itself.

## The files

`scripts/map/courses.mts` writes the index, `src/courses/courses.json` (the calendar, and each term's dates, freshness and file), and each term's sections under `public/data/courses/`, named by content. The index loads with the map; a term file loads once something asks for courses (typing in search, a page, a saved section, a class reminder), and the service worker keeps it ([offline.md](offline.md)). A term's `fetched` is the registrar's timestamp on its oldest page; `built` is when the file was written.

The import fails loud (`registrar.mts`): an unreadable row names its position and field, and a term whose rows don't add up to the API's total, a CRN listed twice, or a building code not in `buildings.mts` is refused. Codes for nowhere (online, TBA, off campus) keep their text and place nothing.

Instructors' addresses are hidden at build time (`email.mts`), shifted and reversed so no address regex matches the shipped JSON or HTML, and the build refuses anything that looks like one. A `mailto:` is assembled only as Email is tapped. UNH publishes the same addresses; this only keeps them from scrapers of static files.

## On the map

- **Search** (`search.mts`), in the home's search and Directions' To: a code in any spelling, a CRN or a pasted schedule, a room with or without its building, titles fuzzily, and people's names, in labelled groups. An instructor's row already says their next class, time, room and Directions.
- **Pages** (`src/map/ui/Pages.tsx`, `src/map/state/page.mts`): `/map/section/202610/12496`, `person/<id>`, `room/Kingsbury+N343`, `course/CS+518`. Directions and Remind are for the meeting the page leads with; Remind on a section goes on meeting after meeting, with nothing saved. A place's page lists its rooms with a class under way, never a count of people.
- **Save** (`saved.mts`, `courses-saved`, synced per person): your next class is a row of Yours on the home, and My courses in You (`/map/you`) has the week, saved sections, a calendar file and a pasted schedule. Cross-listed sections meet together, so either saved is the one class. Classes never make markers or rows in the week.
- **The calendar file** (`ics.mts`) is a snapshot: one VEVENT per pattern with a weekly rule, EXDATEs for days it won't meet and RDATEs for swap days, local times under a VTIMEZONE, UNTIL in UTC, DTSTAMP, lines folded by octet. It says it won't follow a room change.
- **Programs**: a course's page names the programs listing it ("In 6 programs"), each opening its graph focused on the course, `/map/program/<slug>?course=<code>`; `/map/program` lists them ([programs.md](programs.md)).

## Rooms to book

UNH books nearly every space through 25Live Pro (`25live.collegenet.com/pro/unh`, a NetID to book): Dimond's and Kingsbury's study rooms, the MUB, classrooms. Its REST data is readable without signing in and has no CORS, so the build and the Worker read it (`src/courses/bookings.mts`), never the browser.

- **Spaces**: `spaces.json`, one request. Kept are rooms in a Durham building the gazetteer places (`placeMatcher`), not info tables, offices, lounges or lactation rooms; Manchester and the law school are left out. A space is its id, building, room ("221_A", said "221A"), what 25Live calls it ("Collaboration Space"), its capacity where it's more than 25Live's placeholder one, and whether it's a study room. Its page is `/map/room/Dimond+Library+121`; the registrar's text for the same room, `Kingsbury N343`, opens it too (`spaceFor` in `spaces.mts`), so a room is one page whoever names it.
- **Bookings**: `rm_reservations.json` for a day, of some spaces or all, as `{ space, start, end, type, title?, org? }`. Classes are booked "(Private)" and left out, as the registrar's sections say them; cancelled ones too. Who booked (`last_mod_user`, a NetID) is never read, nor is `event.json`, which names a requester.
- **Who's told a title**: any title may name a person ("Ava and Flossie study anatomy"), so titles are said only to a device whose person holds a verified UNH address ([social.md](social.md#identity)), decided by the Worker per request from the device's secret or cookie, without making it a device (`isVerifiedAsker`). Anyone else is told the kind and the organization, unless that's none or students as themselves ("Durham - Student"): "Study group", "Meeting · Theta Chi". The build's snapshot, which anyone can fetch, has no titles (`shownTo`).
- **Fresh as it's needed**: the build bundles the spaces and the coming week (`src/map/rooms.json`, `scripts/map/rooms.mts`), so a room's page opens at once, offline too. `GET /api/rooms/:day` is 25Live's word on a day of the build's rooms, edge-cached ten minutes (25Live takes seconds over it); `GET /api/rooms/:day/:space` one room's, cached 30 s, asked as its page opens, a day is picked, or **Reserve in 25Live** is tapped, which opens the room's own page there. Only yesterday through a month ahead, and only the rooms the served build bundles, are asked of 25Live; its failing is cached 30 s. Answers merge space by space by when each was fetched (`learned`), so a day's answer cached longer never undoes a room's asked since, whatever order they arrive in, and the page changes in place.
- **Free**: what's busy in a room is its bookings and, where the registrar schedules classes there, its classes. Its page leads with "Free till 3:00 PM" or "Busy till 2:00 PM", then the day's bookings and classes together, any day of the week. A room counts as free when nothing's on for 30 minutes, or to the day's end.
- **Campus Rec** (`rec.mts`): Hamel's courts, studios and rooms, the fields and pools, from Campus Rec's Innosoft Fusion site (`crec.unh.edu`), no sign-in. Its facilities are the `<option>`s of its schedule page, placed by the last part of their path ("Bremner Field", a place of its own) else the whole; a court is within its gym, which booked books the court too (`within`, `bookingsOf`). Each facility's week is one request at build time, which is all the map knows of them. Fusion answers DevExtreme appointments: a first occurrence on the local clock with no offset, an RFC 5545 rule (DAILY, WEEKLY with BYDAY and INTERVAL, MONTHLY with BYSETPOS, COUNT, UNTIL in UTC) and exceptions, also local; its window doesn't trim recurring appointments, whose first occurrences come back from years before, so each is expanded, then kept to the week (`occurrencesOf`). What's on there ("Badminton Club") is public and is the booking's kind.
- **A place's page** lists its rooms to book, free ones first, four at first and the rest on a tap; a field that's a space of its own is one "Today's schedule" row.
- **Search** (`createSpaceSearch`), the home search's own group before the courses': a building by name, alias or first word ("MUB", "Dimond"), a room's number or name ("Strafford"), a size ("6 people", "for 6", "6+"), a study room, and a time ("free now", "free at 3pm", "open at 3:30 tomorrow"); free rooms first, study rooms first, then the smallest big enough. A building's name alone finds the building, not its rooms.

## Settled

- **HSSC**, the registrar's "Health Services Science Center", is the Health Sciences Simulation Center at 25 Colovos Rd, between Gregg Hall and Ritzman Lab. OSM draws it unnamed (way 1342295228), so `src/places/added.mts` names it with the extract's outline and door until a generation does.
- **Section restrictions** (majors, class, campus) aren't shipped: `RESTRICTIONS` is HTML prose with its sense embedded ("Only listed…", "…not allowed"), on 37 % of sections. A section's page links to `courses.unh.edu/class/<term>/<crn>`, which gives seats and restrictions as the registrar does.
