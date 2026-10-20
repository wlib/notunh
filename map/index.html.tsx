/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        title="Map · notunh"
        description="Live UNH Wildcat Transit buses, and directions by bus or on foot"
        script="/src/map/index.tsx"
        data={{
          gtfs:      "/src/map/gtfs.json",
          model:     "/src/map/model.json",
          walk:      "/src/map/walk.json",
          gazetteer: "/src/map/gazetteer.json",
          tiles:     "/src/map/tiles.json",
          style:     "/src/map/style.json",
          places:    "/src/map/places.json"
        }}
      />
      <body>
        <div id="app" />
      </body>
    </html>
  ).toStringPromise()
