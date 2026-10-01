/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "./src/shell/Head.tsx"

const REPO = "https://github.com/wlib/notunh"
// Backward, so address harvesters reading the page or this source skip it; page.mts turns it into a link
const EMAIL_BACKWARD = "ude.hnu@egdirhtE.leinaD"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        title="notunh"
        description="An unofficial guide to UNH buses and dining."
        script="/src/shell/page.mts"
      />
      <body>
        <main class="page">
          <header class="intro">
            <h1 class="wordmark"><span>not</span>unh</h1>
            <p>An unofficial guide to UNH buses and dining.</p>
          </header>

          <nav class="sections" aria-label="Sections">
            <a href="/map/">
              <strong>Buses &amp; directions</strong>
              <span>Track Wildcat Transit and find your way by bus or on foot.</span>
              <span class="icon icon-forward" aria-hidden="true" />
            </a>
            <a href="/dining/">
              <strong>Dining menus</strong>
              <span>Every meal at Holloway and Philbrook, with ingredients and allergens.</span>
              <span class="icon icon-forward" aria-hidden="true" />
            </a>
          </nav>

          <p class="muted">
            Keep it handy: add notunh to your home screen.
          </p>

          <section>
            <h2>Made for UNH students</h2>
            <p>
              by Daniel Ethridge. Independent of UNH, free to use, and <a href={REPO}>open source</a>.
            </p>
            <p>
              Have a suggestion or spotted a problem? <a data-email-backward={EMAIL_BACKWARD}>Email Daniel</a> or
              report it on <a href={`${REPO}/issues`}>GitHub</a>.
            </p>
          </section>

          <details>
            <summary>Data sources &amp; credits</summary>
            <dl class="credits">
              <dt>Live buses</dt>
              <dd><a href="https://umoiq.com">Umo IQ</a>, which tracks Wildcat Transit's buses</dd>
              <dt>Bus schedules</dt>
              <dd><a href="https://www.unh.edu/transportation">Wildcat Transit</a></dd>
              <dt>Walking directions</dt>
              <dd><a href="https://project-osrm.org">OSRM</a>, hosted by <a href="https://fossgis.de">FOSSGIS</a></dd>
              <dt>Place search</dt>
              <dd><a href="https://photon.komoot.io">Photon</a>, by Komoot</dd>
              <dt>Map</dt>
              <dd>
                <a href="https://maplibre.org">MapLibre</a>, with tiles from <a href="https://openfreemap.org">OpenFreeMap</a>,
                <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>
              </dd>
              <dt>Menus</dt>
              <dd>UNH Dining, through <a href="https://unh.nutrislice.com">Nutrislice</a></dd>
            </dl>
            <p class="muted">
              Menus and schedules are checked nightly. Built with <a href="https://github.com/Technical-Source/bruh">bruh</a> and <a href="https://vite.dev">Vite</a>,
              and hosted on <a href="https://workers.cloudflare.com">Cloudflare</a>.
            </p>
          </details>
        </main>
      </body>
    </html>
  ).toStringPromise()
