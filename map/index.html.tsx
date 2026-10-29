/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"
import { AppTitle } from "../src/shell/ui.tsx"
import { PAGES } from "../src/shell/pages.mts"
import * as v from "valibot"
import { type Event, EventsData, WEEK, today, upcoming, whereOf } from "../src/social/event.mts"
import { whenOf } from "../src/social/preview.mts"
import { urlOf } from "../src/map/link.mts"
import events from "../src/map/events.json" with { type: "json" }
import gtfs from "../src/map/gtfs.json" with { type: "json" }

/** How many events each list shows, so the shell stays light */
const SHOWN = 40

const Events = ({ list }: { list: readonly Event[] }) =>
  <ul>
    {list.slice(0, SHOWN).map(event =>
      <li><a href={urlOf({ kind: "event", id: event.id })}>{event.title}</a> <span class="muted">{whenOf(event)} · {whereOf(event)}</span></li>
    )}
  </ul>

/**
 * The home's week, as it is when this is built, which a nightly build makes the morning it's served, for search
 * engines and the first paint: the bus routes followed, then today's events and the rest of the week's, each linking
 * to its page. The app replaces it
 */
const Week = ({ now }: { now: number }) => {
  const { events: all } = v.parse(EventsData, events)
  const on = today(all, now).filter(event => event.end > now)
  const later = upcoming(all, now, WEEK).flatMap(({ events }) => events)
  return <>
    <p>Live on every Wildcat Transit route: {gtfs.routes.map(({ name, long }) => name === long ? name : `${name} ${long}`).join(", ")}.</p>
    {on.length > 0 && <><h2>UNH events today</h2><Events list={on} /></>}
    {later.length > 0 && <><h2>Later this week</h2><Events list={later} /></>}
  </>
}

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        path="/map/"
        script="/src/map/index.tsx"
        data={{
          gtfs:      "/src/map/gtfs.json",
          model:     "/src/map/model.json",
          walk:      "/src/map/walk.json",
          gazetteer: "/src/map/gazetteer.json",
          tiles:     "/src/map/tiles.json",
          style:     "/src/map/style.json",
          places:    "/src/map/places.json",
          events:    "/src/map/events.json",
          rooms:     "/src/map/rooms.json",
          courses:   "/src/courses/courses.json",
          prereqs:   "/src/programs/prereqs.json",
          parking:   "/src/parking/parking.json",
          menus:     "/src/dining/menus.json"
        }}
      />
      <body>
        {/* What the app replaces once it's loaded, laid out as it is: the map, the panel's header, and its shell,
            which the Worker replaces in turn on a page of the map with what the page is of (worker/preview.mts) */}
        <div id="app">
          <div class="map" />
          <aside class="panel">
            <div class="grabber" />
            <header class="panel-header">
              <AppTitle page="Map" />
            </header>
            <section class="shell">
              <p class="muted">{PAGES["/map/"].description}</p>
              <Week now={Date.now()} />
            </section>
          </aside>
        </div>
      </body>
    </html>
  ).toStringPromise()
