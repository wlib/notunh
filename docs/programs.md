# Programs: a program's courses by what each needs

A planning view apart from the campus pages: a major, minor, option or cognate's courses laid out by prerequisite, so a student sees what leads to what. It shows the catalog's structure and links to the catalog for the rules. It is never a degree audit: concentrations, credit pools, footnotes, double counting and catalog years leave "is this met" to the catalog, Degree Works and an advisor.

## Data

`scripts/programs/prereqs.mts` (stage `programs/prereqs`) reads catalog.unh.edu: each Durham subject's course-description page, and each Durham undergraduate program page the site map lists (`/undergraduate/<college>/programs-study/<department>/<program>/`, never Professional Studies'), one a second, as `robots.txt` allows. The catalog changes about yearly, so it's read whole **weekly**, or when its year turns; other nights fetch the one page that says the year and keep the files served (`year`, `fetched` in the index). `--fresh` reads it all tonight.

`src/programs/requirements.mts` reads each page's CourseLeaf lists (`table.sc_courselist`) row by row:

- a **heading** (`areaheader`);
- a **course** row, its codes taken together ("CS 791 & CS 792"), with following `orclass` rows as alternatives;
- a **note** in the catalog's words ("Select one course from the following:"), with what's indented under it, or, for a note pointing to what follows ("following", "below") with nothing indented, the course rows after it up to the next heading or note, each carrying its own credits (as Mechanical Engineering's technical electives).

The words are kept, never interpreted: nothing counts "pick N" or credits. A program's rows are kept only when every row is one of those, nothing is indented under nothing, and no note pointing to a list ("following", "below", "list") has nothing under it, since otherwise a choice could be mistaken for a requirement. Failing that, the program keeps only the courses its requirements name, listed with a link to the catalog. In the 2026–27 catalog, 250 of 293 Durham programs read for sure. The stage fails, keeping the last files, if under 97 % of prerequisite sentences read for sure, under 200 programs are found, or under half their lists read.

The **sample degree plan** (`table.sc_plangrid`, Degree Plan tab) is read the same way (`planOf`): a year, a term, a course row with alternatives, or a comment like "Discovery I". It's kept (`plan`) only with exactly one grid, every row read, naming at least half the courses on rows of their own, as an option's page may carry its major's plan. 96 programs have one.

Each program is its own file (`Program` in `src/programs/program.mts`, 1 to 3 KB gzipped) under `/data/programs/`, named by content, with the titles of its courses and what they need. The list of programs, with each course's programs, is one more (about 24 KB gzipped). The index (`src/programs/prereqs.json`) names them all (`programs`, `files`), so the service worker keeps each once loaded.

## The graph

`graphOf` in `src/programs/graph.mts`, pure and property-tested:

- **Core**: courses on rows of their own or as their alternatives, and everything those need, however far back, drawn faint. Of alternatives, only those the program names are drawn where it names any, so "MATH 539 or one of seven others" is MATH 539 in a program listing it.
- **Pools** (`poolsOf`): the choices under one note, one node opening to its members, labelled with the note's words, the heading, a preceding empty note (the catalog's own sub-heading), credits and the number of choices. A course is in the first pool listing it, never two, never both node and member. A member's needs outside the graph are folded into its page. The CS major is 30 courses and 2 pools.
- **Edges**: from each prerequisite to the course needing it, dashed where it's one alternative of several; into a pool from whatever any member needs, and out to whatever needs a member, members' own edges kept for when it's open. A loop of needs ("or concurrently" both ways) loses the edge closing it.
- **Levels**: a node sits one past the furthest thing it needs, so every edge points later. Within a level, nodes go by the mean place of what they need, swept down, then of what needs them, swept up (barycenter); ties put the core first, then code, pools after courses.
- **Terms** (`byTerm`): the same nodes laid out by the plan's terms, each course in the first term naming it, an alternative in place of the course the plan names, and the rest, pools among them, in a last lane "Not in the plan".
- **Focus**: `chainOf` gives what a node needs back to nodes needing nothing, and what it unlocks, each closed.

## The view

`src/map/ui/Program.tsx`, at `/map/program/<slug>`, `?course=<code>` for the course in focus, changing in place. One markup, laid out by container queries (`src/map/index.css`):

- **Phone**: the sheet goes tall; lanes stack, each a wrapping grid of courses, a pool across the row; only the focused chain's edges are drawn.
- **Wide**: the panel widens to the screen; lanes are columns sharing the width, every edge faint and the focused chain's bold, scrolling sideways once columns can't fit.
- **Tapping a course** focuses it, dimming the rest; a card says how it's listed and under which heading and note, what it needs, what it unlocks here, and terms with sections, opening its course page. On a phone the card follows the course in its lane; wide, it sits at the top. Back returns to the graph as it was.
- **Tapping a pool** opens it to its courses, each a node with its edges; a course opened from its page opens its pool.
- **By term** uses the sample plan where there is one; **As listed** shows the rows as the catalog lays them out. Notes with nothing under them ("Select three additional CS courses numbered 690-799") are listed below as "Also listed".
- `/map/program` alone is the list, searched by title; given a course, it leads with those naming it. Search finds programs by title too.

## Left open

- Only the current catalog year can be read (`/archives/` is disallowed), so a student on an older catalog sees this year's lists.
- The plan's placeholders ("Discovery I", "Implementation Elective") aren't matched to pools, so by term pools sit in "Not in the plan".
- Durham's undergraduate catalog has no undergraduate certificates; graduate programs aren't read.
