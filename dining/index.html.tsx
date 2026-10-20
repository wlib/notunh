/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"
import { AppTitle } from "../src/shell/ui.tsx"
import { PAGES } from "../src/shell/pages.mts"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        path="/dining/"
        script="/src/dining/index.tsx"
        data={{ menus: "/src/dining/menus.json" }}
      />
      <body>
        {/* What the app replaces once it's loaded: its header, and what it does, which names the halls */}
        <div id="app">
          <main class="dining">
            <header>
              <AppTitle page="Dining" />
            </header>
            <p class="shell muted">{PAGES["/dining/"].description}</p>
          </main>
        </div>
      </body>
    </html>
  ).toStringPromise()
