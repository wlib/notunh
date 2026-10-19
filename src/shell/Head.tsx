/** @jsxImportSource bruh/server */

import { SURFACE } from "./theme.mts"

// When this build was made, once for every page of it, which orders releases: a copy of a page from an edge not
// yet caught up is told from a newer one by it (src/sw/worker.mts)
const RELEASE = new Date().toISOString()

/**
 * The <head> every page shares, around its own title, description, entry script, and data files, each by a name
 * and its source, which the build hashes. They're preloaded alongside the code, and the page finds them here by
 * name (manifest.mts), so a newer build's data can be told from its code and swapped in
 */
export const Head = ({ title, description, script, data = {} }: {
  title:       string,
  description: string,
  script:      string,
  data?:       Record<string, string>
}) =>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />

    <title>{title}</title>
    <meta name="description" content={description} />
    <meta name="release" content={RELEASE} />

    <meta name="theme-color" media="(prefers-color-scheme: light)" content={SURFACE.light} />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content={SURFACE.dark} />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon-180.png" />

    <script type="module" src={script} />
    {Object.entries(data).map(([name, source]) =>
      <link rel="preload" as="fetch" crossorigin="anonymous" href={source} data-name={name} />
    )}
  </head>
