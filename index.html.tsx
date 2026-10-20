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
        description="An unofficial guide to UNH buses, dining, and laundry."
        script="/src/shell/page.mts"
      />
      <body>
        <main class="page">
          <header class="intro">
            <h1 class="wordmark"><span>not</span>unh</h1>
            <p>An unofficial guide to UNH buses, dining, and laundry.</p>
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
            <a href="/laundry/">
              <strong>Laundry</strong>
              <span>Which washers and dryers are free in every residence hall, and when they usually aren't.</span>
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

          <section>
            <h2>Usage stats</h2>
            <p>
              notunh counts page views and errors with <a href="https://posthog.com">PostHog</a>, for notunh and nothing
              else, so it's clear what to fix and what to work on next. Nothing is stored on your device for that, and
              nothing in it says who you are.
            </p>
            <p>
              If you allow it, notunh also remembers this device between visits and counts which features get used, and
              which buildings and bus stops people plan trips between. Each trip is counted on its own, by the stop or
              building nearest each end and the hour, never tied to you or anything else you do.
            </p>
            <p>
              Never your exact location, what you type or search for, or anything that says who you are. Never sold,
              never used for ads.
            </p>
            <label class="choice">
              <input type="checkbox" data-usage />
              Share usage stats
            </label>
            <p class="muted" data-usage-private hidden>
              Your browser asks sites not to share what you do there (Global Privacy Control), so notunh counts only page
              views and errors.
            </p>
          </section>

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
                <a href="https://maplibre.org">MapLibre</a>, with tiles from <a href="https://openfreemap.org">OpenFreeMap</a>,
                <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>
              </dd>
              <dt>Menus</dt>
              <dd>UNH Dining, through <a href="https://unh.nutrislice.com">Nutrislice</a></dd>
              <dt>Laundry</dt>
              <dd>The machines' own status, from <a href="https://laundryconnectlive.com">LaundryConnect</a> by Automatic Laundry</dd>
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
