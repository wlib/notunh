// A page's summary as the Worker writes it into a body (src/shell/summary.mts): whatever its words, only its own tags
// are tags, its words read back as they were, and only a path on the site or an http(s) page is a link

import { test, expect } from "vitest"
import fc from "fast-check"
import { type Summary, safeHref, summaryHtml } from "../../src/shell/summary.mts"

const TAGS = /<(\/?)(section|header|p|h1|h2|ul|li|a|span)((?: (?:class|href)="[^"<>]*")*)>/g

const unescaped = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&amp;", "&")

/** Words with what HTML would take for markup among them */
const words = fc.oneof(fc.string(), fc.constantFrom("<script>alert(1)</script>", "\"><img src=x onerror=alert(1)>", "&amp; & <", "</section>"))
const href = fc.oneof(fc.webUrl(), fc.webPath(), fc.constantFrom("javascript:alert(1)", "//evil.example/x", "data:text/html,<b>", " /map/", "\"onmouseover=\"x"))

const summary: fc.Arbitrary<Summary> = fc.record({
  kind:  words,
  title: words,
  lines: fc.array(words, { maxLength: 3 }),
  parts: fc.array(fc.record({
    heading: words,
    lines:   fc.option(fc.array(words, { maxLength: 2 }), { nil: undefined }),
    items:   fc.option(fc.array(fc.record({ text: words, href: fc.option(href, { nil: undefined }), detail: fc.option(words, { nil: undefined }) }), { maxLength: 3 }), { nil: undefined })
  }), { maxLength: 3 })
})

test("whatever a summary says, its only tags are its own, its one h1 is its title, and its words read back as they were", () =>
  fc.assert(fc.property(summary, summary => {
    const html = summaryHtml(summary)
    const text = html.replace(TAGS, "")
    expect(text).not.toMatch(/[<>]/)
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(unescaped(html.match(/<h1>([^<]*)<\/h1>/)![1])).toBe(summary.title)
    expect(html.startsWith(`<section class="shell summary">`) && html.endsWith("</section>")).toBe(true)
    // One section, so a shell holding it ends where it does
    expect(html.match(/<\/?section/g)).toHaveLength(2)
    for (const word of [summary.kind, ...summary.lines, ...summary.parts.flatMap(({ heading, lines = [], items = [] }) => [heading, ...lines, ...items.flatMap(({ text, detail }) => [text, detail ?? ""])])])
      expect(unescaped(text)).toContain(word)
  }))
)

test("a link goes only to a path on the site or a page over http(s)", () => {
  fc.assert(fc.property(summary, summary => {
    for (const [, link] of summaryHtml(summary).matchAll(/href="([^"]*)"/g))
      expect(unescaped(link)).toMatch(/^(\/(?!\/)|https?:\/\/)/i)
  }))
  expect(safeHref("/map/place/Kingsbury+Hall")).toBe("/map/place/Kingsbury+Hall")
  expect(safeHref("https://unh.presence.io/event/x")).toBe("https://unh.presence.io/event/x")
  for (const unsafe of ["javascript:alert(1)", "//evil.example", "data:text/html,x", " /map/", "mailto:a@unh.edu"])
    expect(safeHref(unsafe), unsafe).toBeUndefined()
})
