// What a page says in its body before its app replaces it, written on the server for crawlers and the first paint:
// what kind of thing it is, its title as the page's heading, a line of facts, and parts, each a heading over lines or
// a list of links. The Worker writes one into the map's pages and the laundry rooms' (worker/preview.mts) in place of
// the page's shell, which the app replaces whole on loading, so nobody sees it twice. Every word is escaped, and only
// a path on the site or an http(s) link is ever a link

import type { Preview } from "../social/preview.mts"

/** A row of a part's list: its words, where it links, and what else to say beside it */
export type Item = { text: string, href?: string, detail?: string }

/** A part of a page's body: a heading, then lines, then a list */
export type Part = { heading: string, lines?: string[], items?: Item[] }

/** A page's summary: its preview, as its head says it, and its parts */
export type Summary = Preview & { parts: Part[] }

/** Text as HTML holds it, in an element or a quoted attribute */
export const escaped = (text: string) =>
  text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!)

/** Where a link may go: a path on the site, or a page over http(s), else nowhere */
export const safeHref = (href: string | undefined) =>
  href !== undefined && (/^\/(?!\/)/.test(href) || /^https?:\/\//i.test(href)) ? href : undefined

const itemHtml = ({ text, href, detail }: Item) => {
  const link = safeHref(href)
  return `<li>${link ? `<a href="${escaped(link)}">${escaped(text)}</a>` : escaped(text)}${detail ? ` <span class="muted">${escaped(detail)}</span>` : ""}</li>`
}

/** The shell's markup for a summary: one section, whose title is the page's one h1 */
export const summaryHtml = ({ kind, title, lines, parts }: Summary) =>
  [
    `<section class="shell summary">`,
    `<header><p class="summary-kind">${escaped(kind)}</p><h1>${escaped(title)}</h1></header>`,
    lines.length ? `<p class="summary-facts">${lines.map(escaped).join(" · ")}</p>` : "",
    ...parts.map(({ heading, lines = [], items = [] }) => [
      `<h2 class="eyebrow">${escaped(heading)}</h2>`,
      ...lines.map(line => `<p>${escaped(line)}</p>`),
      items.length ? `<ul>${items.map(itemHtml).join("")}</ul>` : ""
    ].join("")),
    `</section>`
  ].join("")
