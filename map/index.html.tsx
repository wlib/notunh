/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"
import { AppTitle } from "../src/shell/ui.tsx"
import { PAGES } from "../src/shell/pages.mts"

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
          courses:   "/src/courses/courses.json",
          prereqs:   "/src/programs/prereqs.json",
          parking:   "/src/parking/parking.json",
          menus:     "/src/dining/menus.json"
        }}
      />
      <body>
        {/* What the app replaces once it's loaded, laid out as it is: the map, and the panel's header */}
        <div id="app">
          <div class="map" />
          <aside class="panel">
            <div class="grabber" />
            <header class="panel-header">
              <AppTitle page="Map" />
            </header>
            <p class="shell muted">{PAGES["/map/"].description}</p>
          </aside>
        </div>
      </body>
    </html>
  ).toStringPromise()
