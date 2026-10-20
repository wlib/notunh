/** @jsxImportSource bruh/server */

import { SURFACE } from "./theme.mts"

// When this build was made, the same for every page of it. It orders releases, so a copy of a page from an edge not
// yet caught up can be told from a newer one (manifest.mts' isOlder)
const RELEASE = new Date().toISOString()

/**
 * Fetches the data files the head's links name as it's parsed, alongside the code, keeping each response on its link
 * for the file's first load to take (load.mts). Not preloads: Safari never hands one to fetch(), so a file preloaded
 * downloaded twice
 */
export const FETCH_DATA = `for (const link of document.querySelectorAll("link[data-name]")) (link.response = fetch(link.href)).catch(() => {})`

/**
 * The <head> every page shares, around its own title, description, entry script, and data files. Data files are
 * given by name and source path, and the build hashes them. They're fetched alongside the code, and the page finds
 * them here by name (manifest.mts), so a newer build's data can be told apart from its code and swapped in. Their
 * links are of a rel no browser acts on, so only FETCH_DATA fetches them
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
      <link rel="data" href={source} data-name={name} />
    )}
    <script>{FETCH_DATA}</script>
  </head>
