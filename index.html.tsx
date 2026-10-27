/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "./src/shell/Head.tsx"

const REPO = "https://github.com/wlib/notunh"
// Backward, so address harvesters reading the page or this source skip it; page.mts turns it into a link
const EMAIL_BACKWARD = "ude.hnu@egdirhtE.leinaD"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head path="/" script="/src/shell/page.mts" />
      <body>
        <main class="page">
          <header class="intro">
            <h1 class="wordmark"><span>not</span>unh</h1>
            <p>An unofficial guide to UNH.</p>
          </header>

          <nav class="sections" aria-label="Sections">
            <a href="/map/">
              <strong>Map</strong>
              <span>Live buses, directions, classes, parking, and what's on today.</span>
              <span class="icon icon-forward" aria-hidden="true" />
            </a>
            <a href="/dining/">
              <strong>Dining menus</strong>
              <span>Holloway and Philbrook, with ingredients and allergens.</span>
              <span class="icon icon-forward" aria-hidden="true" />
            </a>
            <a href="/laundry/">
              <strong>Laundry</strong>
              <span>Free washers and dryers in every residence hall.</span>
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

          <details id="usage">
            <summary>Usage stats</summary>
            <p>notunh records basic info like page views and errors for everyone.</p>
            <p>If you opt in, notunh also collects stats without identifying you, like:</p>
            <ul>
              <li>which features people use and how</li>
              <li>which bus stops and buildings are popular</li>
            </ul>
            <p>
              It never collects your exact location or what you type. Stats are kept in{" "}
              <a href="https://posthog.com">PostHog</a> and aren't shared with anyone else or used for ads.
            </p>
            <label class="choice">
              <input type="checkbox" data-usage />
              Share usage stats
            </label>
            <p class="muted" data-usage-private hidden>
              Your browser has Global Privacy Control on, so only page views and errors are counted.
            </p>
          </details>

          <details>
            <summary>Data sources &amp; credits</summary>
            <dl class="credits">
              <dt>Live buses</dt>
              <dd><a href="https://umoiq.com">Umo IQ</a>, which tracks Wildcat Transit's buses</dd>
              <dt>Bus schedules</dt>
              <dd><a href="https://www.unh.edu/transportation">Wildcat Transit</a></dd>
              <dt>Walking directions and places</dt>
              <dd>The streets, paths, and buildings of <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a></dd>
              <dt>Place search</dt>
              <dd><a href="https://photon.komoot.io">Photon</a>, by Komoot</dd>
              <dt>Map</dt>
              <dd>
                <a href="https://maplibre.org">MapLibre</a>, with tiles from <a href="https://openfreemap.org">OpenFreeMap</a>,{" "}
                <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>
              </dd>
              <dt>Events</dt>
              <dd>
                <a href="https://unh.presence.io">Wildcat Link</a>, the <a href="https://www.unh.edu/calendar">UNH Events Calendar</a>,{" "}
                <a href="https://unhwildcats.com">UNH Athletics</a>, and <a href="https://unh.dserec.com/online/clubsports">Club Sports</a>
              </dd>
              <dt>Classes</dt>
              <dd>
                UNH's <a href="https://courses.unh.edu">Course Search</a> and academic calendar; prerequisites and programs from{" "}
                the <a href="https://catalog.unh.edu">UNH Catalog</a>
              </dd>
              <dt>Parking</dt>
              <dd>
                <a href="https://www.unh.edu/transportation/parking">UNH Transportation</a>,{" "}
                <a href="https://parkmobile.io">ParkMobile</a> zones, and lots from{" "}
                <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>
              </dd>
              <dt>Menus</dt>
              <dd>UNH Dining, through <a href="https://unh.nutrislice.com">Nutrislice</a></dd>
              <dt>Laundry</dt>
              <dd>The machines' own status, from <a href="https://laundryconnectlive.com">LaundryConnect</a> by Automatic Laundry</dd>
            </dl>
            <p class="muted">
              Everything is checked nightly. Built with <a href="https://github.com/Technical-Source/bruh">bruh</a> and <a href="https://vite.dev">Vite</a>,
              and hosted on <a href="https://workers.cloudflare.com">Cloudflare</a>.
            </p>
          </details>
        </main>
      </body>
    </html>
  ).toStringPromise()
