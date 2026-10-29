/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"
import { AppTitle } from "../src/shell/ui.tsx"
import { PAGES } from "../src/shell/pages.mts"
import { ROOMS, pathOf } from "../src/laundry/rooms.mts"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        path="/laundry/"
        script="/src/laundry/index.tsx"
        data={{ usual: "/src/laundry/usual.json" }}
      />
      <body>
        {/* What the app replaces once it's loaded: its header, what it does, which the Worker replaces with the room on
            a room's own address (worker/preview.mts), and every room, which are this build's, in the list's own rows.
            No counts, which would be stale */}
        <div id="app">
          <main class="laundry">
            <header>
              <AppTitle page="Laundry" />
            </header>
            <section class="shell">
              <p class="muted">{PAGES["/laundry/"].description}</p>
            </section>
            <ul class="rooms">
              {ROOMS.map(({ id, name }) =>
                <li class="room-row">
                  <a href={pathOf(id)} class="room-open">
                    <span class="room-name"><strong>{name}</strong></span>
                  </a>
                </li>
              )}
            </ul>
          </main>
        </div>
      </body>
    </html>
  ).toStringPromise()
