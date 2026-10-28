/** @jsxImportSource bruh/server */

import { SURFACE } from "./theme.mts"
import { AUTHOR, IMAGE, NAME, PAGES, SITE, type Path, imageOf, scriptJson } from "./pages.mts"
import { structuredDataOf } from "./structured.mts"

// When this build was made, the same for every page of it. It orders releases, so a copy of a page from an edge not
// yet caught up can be told from a newer one (manifest.mts' isOlder)
export const RELEASE = new Date().toISOString()

// The one origin that sends usage stats (usage.tsx): the site's own. A copy served anywhere else, like in development,
// a Preview, or the browser tests' server unless it stands in for this one, sends nothing
const USAGE_ORIGIN = SITE

/**
 * Fetches the data files the head's links name as it's parsed, alongside the code, keeping each response on its link
 * for the file's first load to take (load.mts). Not preloads: Safari never hands one to fetch(), so a file preloaded
 * downloaded twice
 */
export const FETCH_DATA = `for (const link of document.querySelectorAll("link[data-name]")) (link.response = fetch(link.href)).catch(() => {})`

/** An Open Graph meta, whose property attribute html-info doesn't know, so it's spread past the type of a meta's */
const Property = ({ name, content }: { name: string, content: string }) =>
  <meta {...{ property: name }} content={content} />

/**
 * The <head> every page shares, around its own entry script and data files, with what search engines and link
 * previews read of it by its path (pages.mts). Those name absolute URLs, which a head's release manifest passes over
 * (manifest.mts), so the service worker never takes a social image for code. Data files are given by name and source
 * path, and the build hashes them. They're fetched alongside the code, and the page finds them here by name
 * (manifest.mts), so a newer build's data can be told apart from its code and swapped in. Their links are of a rel no
 * browser acts on, so only FETCH_DATA fetches them
 */
export const Head = ({ path, script, data = {} }: {
  path:   Path,
  script: string,
  data?:  Record<string, string>
}) => {
  const { title, description, label, shows } = PAGES[path]
  const url = SITE + path
  const image = SITE + imageOf(path)
  const alt = `${NAME}: ${label}. ${shows}`
  return <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />

    <title>{title}</title>
    <meta name="description" content={description} />
    <meta name="author" content={AUTHOR.name} />
    <link rel="canonical" href={url} />
    <meta name="release" content={RELEASE} />
    <meta name="usage-origin" content={USAGE_ORIGIN} />

    <meta name="theme-color" media="(prefers-color-scheme: light)" content={SURFACE.light} />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content={SURFACE.dark} />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content={NAME} />

    <Property name="og:type" content="website" />
    <Property name="og:site_name" content={NAME} />
    <Property name="og:locale" content="en_US" />
    <Property name="og:title" content={title} />
    <Property name="og:description" content={description} />
    <Property name="og:url" content={url} />
    <Property name="og:image" content={image} />
    <Property name="og:image:type" content="image/png" />
    <Property name="og:image:width" content={`${IMAGE.width}`} />
    <Property name="og:image:height" content={`${IMAGE.height}`} />
    <Property name="og:image:alt" content={alt} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <meta name="twitter:image" content={image} />
    <meta name="twitter:image:alt" content={alt} />
    <script type="application/ld+json">{scriptJson(structuredDataOf(path))}</script>

    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/icon-180.png" />

    <script type="module" src={script} />
    {Object.entries(data).map(([name, source]) =>
      <link rel="data" href={source} data-name={name} />
    )}
    <script>{FETCH_DATA}</script>
  </head>
}
