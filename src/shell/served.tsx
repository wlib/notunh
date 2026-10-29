/** @jsxImportSource bruh/server */

// A built page served as what it's of, by the Worker (worker/preview.mts), for crawlers, link previews and the first
// paint. Its head's words are replaced with another's: a title, description, canonical address, card and structured
// data, and it's kept out of search where it's not to be listed. Its shell is replaced with a summary: what kind of
// thing the page is, its title as the page's one heading, a line of facts, and parts, each a heading over lines or a
// list of links, which the app replaces whole as it loads, so nobody sees it twice. bruh renders every tag and
// escapes every word, and only a path on the site or an http(s) page is ever a link

import type { Thing, WithContext } from "schema-dts"
import { type Preview, describe } from "../social/preview.mts"
import { NAME, scriptJson } from "./pages.mts"

/** A row of a part's list: its words, where it links, and what else to say beside it */
export type Item = { text: string, href?: string, detail?: string }

/** A part of a page's body: a heading, then lines, then a list */
export type Part = { heading: string, lines?: string[], items?: Item[] }

/** What a page says of itself: its preview, which heads it and draws its card, and the parts of its body */
export type Summary = { preview: Preview, parts: Part[] }

/** What a page's head says of it: its title and line, its own address and its card's, its structured data, and whether search may list it */
export type Head = { title: string, description: string, url: string, image: string, data: WithContext<Thing>[], isListed: boolean }

/**
 * A page's head from its preview, its address and its card's: titled as search shows it where that's given, else as
 * the preview is, with what its title adds to say it's of UNH, unless the title has it
 */
export const headOf = (preview: Preview, url: string, image: string, { title, context, data = [], isListed = true }: { title?: string, context?: string, data?: WithContext<Thing>[], isListed?: boolean } = {}): Head => ({
  title:       title ?? [preview.title, context && !preview.title.includes("UNH") ? context : "", NAME].filter(Boolean).join(" · "),
  description: describe(preview),
  url,
  image,
  data,
  isListed
})

/** Kept out of search engines' results, in a page's head */
const NOINDEX = <meta name="robots" content="noindex" />

/** A meta by its name or property, which html-info doesn't know, so it's spread past the type of a meta's */
const Meta = ({ attribute, name, content }: { attribute: string, name: string, content: string }) =>
  <meta {...{ [attribute]: name } as {}} content={content} />

/**
 * A built page's HTML with another head's words in place of its own: its title, every meta that previews and search
 * engines read that the page has, its canonical address and its structured data, kept out of search where it's not
 * to be listed, with nothing else changed
 */
export const withHead = (html: string, { title, description, url, image, data, isListed }: Head) => {
  const alt = `${title}: ${description}`
  const named = new Map([
    ["description", description],
    ["og:title", title], ["twitter:title", title],
    ["og:description", description], ["twitter:description", description],
    ["og:url", url],
    ["og:image", image], ["twitter:image", image],
    ["og:image:alt", alt], ["twitter:image:alt", alt]
  ])
  const [head, ...body] = html.split("</head>")
  return [
    head
      .replace(/<title>[^<]*<\/title>/, () => `${<title>{title}</title>}`)
      .replace(/<meta (name|property)="([^"]+)" content="[^"]*">/g, (tag, attribute: string, name: string) => named.has(name) ? `${<Meta attribute={attribute} name={name} content={named.get(name)!} />}` : tag)
      .replace(/<link rel="canonical" href="[^"]*">/, () => `${<link rel="canonical" href={url} />}`)
      // scriptJson escapes every "<", so the script's JSON holds none
      .replace(/<script type="application\/ld\+json">[^<]*<\/script>/, () => data.length ? `${<script type="application/ld+json">{scriptJson(data)}</script>}` : "")
      + (isListed ? "" : `${NOINDEX}`),
    ...body
  ].join("</head>")
}

/** A built page's HTML kept out of search, as a page of nothing there is is */
export const unlisted = (html: string) =>
  html.replace("</head>", `${NOINDEX}</head>`)

/** Where a link may go: a path on the site, or a page over http(s), else nowhere */
export const safeHref = (href: string | undefined) =>
  href !== undefined && (/^\/(?!\/)/.test(href) || /^https?:\/\//i.test(href)) ? href : undefined

const Row = ({ text, href, detail }: Item) => {
  const link = safeHref(href)
  return <li>{link ? <a href={link}>{text}</a> : text}{detail ? [" ", <span class="muted">{detail}</span>] : ""}</li>
}

/** The shell's markup for a summary: one section, whose title is the page's one h1 */
export const summaryHtml = ({ preview: { kind, title, lines }, parts }: Summary) => `${
  <section class="shell summary">
    <header><p class="summary-kind">{kind}</p><h1>{title}</h1></header>
    {lines.length ? <p class="summary-facts">{lines.join(" · ")}</p> : ""}
    {parts.map(({ heading, lines = [], items = [] }) => [
      <h2 class="eyebrow">{heading}</h2>,
      lines.map(line => <p>{line}</p>),
      items.length ? <ul>{items.map(item => <Row {...item} />)}</ul> : ""
    ])}
  </section>
}`

/**
 * A built page's HTML saying a summary in its body: in place of its shell, the first <section class="shell">, with the
 * app's title no longer the page's heading, which the summary's title is. The app replaces both as it loads
 */
export const withSummary = (html: string, summary: Summary) => {
  const body = Math.max(0, html.indexOf("<body"))
  return html.slice(0, body) + html.slice(body)
    .replace(/<h1 class="app-title">([\s\S]*?)<\/h1>/, (_, title: string) => `<p class="app-title">${title}</p>`)
    .replace(/<section class="shell">[\s\S]*?<\/section>/, () => summaryHtml(summary))
}
