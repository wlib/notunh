/** @jsxImportSource bruh/server */

// A pin's page, at /p/<id>, which the Worker serves with the pin's title and a line about it in place of these
// (worker/social.mts), for link previews, and the app fills in from the pin itself (src/social/pin.tsx). It's built
// as a static page, so the service worker keeps one copy for every pin, and it opens with no account and no install

import { MetaDocument } from "bruh/server"
import { SURFACE } from "../src/shell/theme.mts"
import { RELEASE } from "../src/shell/Head.tsx"
import { IMAGE, NAME, SITE } from "../src/shell/pages.mts"

const TITLE = "An event · notunh"
const DESCRIPTION = "A place and a time on the UNH map, with directions and a reminder to leave"
const IMAGE_URL = `${SITE}/social/pin.png`

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="robots" content="noindex" />
        <meta name="release" content={RELEASE} />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={SURFACE.light} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={SURFACE.dark} />
        <meta name="apple-mobile-web-app-title" content={NAME} />
        <meta {...{ property: "og:type" }} content="website" />
        <meta {...{ property: "og:site_name" }} content={NAME} />
        <meta {...{ property: "og:title" }} content={TITLE} />
        <meta {...{ property: "og:description" }} content={DESCRIPTION} />
        <meta {...{ property: "og:url" }} content={`${SITE}/p/`} />
        <meta {...{ property: "og:image" }} content={IMAGE_URL} />
        <meta {...{ property: "og:image:width" }} content={`${IMAGE.width}`} />
        <meta {...{ property: "og:image:height" }} content={`${IMAGE.height}`} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={IMAGE_URL} />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icon-180.png" />
        <script type="module" src="/src/social/pin.tsx" />
      </head>
      <body>
        <main class="page pin" id="app">
          <p class="muted">Loading the pin…</p>
        </main>
      </body>
    </html>
  ).toStringPromise()
