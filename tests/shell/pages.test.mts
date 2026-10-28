import { test, expect, vi } from "vitest"
import * as v from "valibot"
import fc from "fast-check"
import sharp from "sharp"
import { readFile } from "node:fs/promises"
import { buildOf } from "../../src/shell/manifest.mts"
import { IMAGE, PAGES, PATHS, SITE, imageOf, scriptJson, type Path } from "../../src/shell/pages.mts"
import { type Meal, MenusIndex, fileUrl } from "../../src/dining/menus.mts"
import { EventsData } from "../../src/social/event.mts"
import { urlOf } from "../../src/map/link.mts"
import { HOUR, dayStart, localDay } from "../../src/shared/time.mts"
import menus from "../../src/dining/menus.json" with { type: "json" }
import events from "../../src/map/events.json" with { type: "json" }

/** Each page as the build renders it, by its path */
const rendered = Object.fromEntries(await Promise.all(PATHS.map(async path => {
  const page = new URL(`../..${path}index.html.tsx`, import.meta.url).href
  return [path, await (await import(page)).default() as string]
}))) as Record<Path, string>

const headOf = (html: string) =>
  html.split("</head>")[0]

/** A meta's content by its name or property */
const metaOf = (html: string, name: string) =>
  headOf(html).match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1]

test("every page names its canonical URL, Open Graph, and Twitter card, all absolute on the site", () => {
  for (const path of PATHS) {
    const html = rendered[path]
    const url = SITE + path
    expect(headOf(html), path).toContain(`<link rel="canonical" href="${url}">`)
    expect(metaOf(html, "og:url"), path).toBe(url)
    for (const name of ["og:image", "twitter:image"])
      expect(metaOf(html, name), path).toBe(SITE + imageOf(path))
    expect(metaOf(html, "og:image:width")).toBe(`${IMAGE.width}`)
    expect(metaOf(html, "og:image:height")).toBe(`${IMAGE.height}`)
    expect(metaOf(html, "twitter:card")).toBe("summary_large_image")
    for (const name of ["og:title", "og:description", "og:image:alt", "og:site_name", "og:locale", "twitter:title", "twitter:description", "twitter:image:alt"])
      expect(metaOf(html, name), `${path} ${name}`).toBeTruthy()
  }
})

test("each page's title names the app and UNH, and its description fits a search result", () => {
  for (const { title, description } of Object.values(PAGES)) {
    expect(title).toContain("notunh")
    expect(title).toContain("UNH")
    expect(title.length, title).toBeLessThanOrEqual(65)
    expect(description.length, description).toBeLessThanOrEqual(155)
  }
})

test("each page's social image is there, as big as its head says, and small enough for a preview to fetch", async () => {
  for (const path of PATHS) {
    const image = await readFile(new URL(`../../public${imageOf(path)}`, import.meta.url))
    const { width, height, format } = await sharp(image).metadata()
    expect({ width, height, format }, path).toEqual({ ...IMAGE, format: "png" })
    expect(image.length, path).toBeLessThan(300_000)
  }
})

test("what a page names for search engines and previews isn't code the service worker keeps for it", () => {
  for (const path of PATHS) {
    const { code } = buildOf(rendered[path])
    expect(code.every(url => url.startsWith("/") && !url.startsWith("/social/")), path).toBe(true)
  }
})

test("each page's structured data parses, with what Google reads: the site's names and logo on the home page, and the trail to each other", () => {
  for (const path of PATHS) {
    const json = headOf(rendered[path]).match(/<script type="application\/ld\+json">([^<]*)<\/script>/)![1]
    const things = JSON.parse(json)
    expect(things.every((thing: Record<string, unknown>) => thing["@context"] === "https://schema.org"), path).toBe(true)
    if (path === "/") {
      expect(things.map((thing: { "@type": string }) => thing["@type"])).toEqual(["WebSite", "Organization"])
      expect(things[0]).toMatchObject({ name: "notunh", alternateName: expect.arrayContaining(["not UNH", "notUNH"]), url: `${SITE}/` })
      expect(things[1]).toMatchObject({ name: "notunh", url: `${SITE}/`, logo: `${SITE}/icon-512.png`, founder: { "@type": "Person", name: "Daniel Ethridge" } })
    }
    else
      expect(things).toEqual([{
        "@context":      "https://schema.org",
        "@type":         "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "notunh", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: PAGES[path].name, item: SITE + path }
        ]
      }])
  }
})

test("JSON in a script reads back as it was, and nothing in it can end the script", () => {
  fc.assert(fc.property(fc.jsonValue(), value => {
    const json = scriptJson(value)
    expect(json).not.toContain("<")
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(value)))
  }))
})

test("each page's shell says what it does before its app loads, with the laundry rooms as links", () => {
  for (const path of PATHS) {
    const body = rendered[path].split("<body>")[1]
    expect(body, path).toContain(path === "/" ? "<h1" : `class="app-title"`)
  }
  for (const path of ["/map/", "/dining/", "/laundry/"] as const)
    expect(rendered[path].split("<body>")[1]).toContain(PAGES[path].description)
  expect(rendered["/laundry/"]).toMatch(/<a href="\/laundry\/[\w-]+\/" class="room-open">/)
})

/** A page rendered as the build would on a day of its data, at an hour of it in Durham */
const renderedAt = async (path: Path, at: number) => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(at)
  try {
    return await (await import(new URL(`../..${path}index.html.tsx`, import.meta.url).href)).default() as string
  }
  finally {
    vi.useRealTimers()
  }
}

test("the dining page's shell lists each hall's menus on the day it's built, by meal and station, escaped", async () => {
  const index = v.parse(MenusIndex, menus)
  const [hall] = index.halls.filter(({ id }) => Object.keys(index.days[id] ?? {}).length)
  const [day, { file }] = Object.entries(index.days[hall.id])[0]
  const meals = JSON.parse(await readFile(new URL(`../../public${fileUrl(file)}`, import.meta.url), "utf8")) as Meal[]
  const body = (await renderedAt("/dining/", dayStart(day) + 9 * HOUR)).split("<body>")[1]
  expect(body).toMatch(/<h2>Holloway &amp; Philbrook menus for \w+day, \w+ \d+<\/h2>/)
  expect(body).toContain(`<h3>${hall.name}</h3>`)
  const { name } = meals[0].stations[0].foods[0]
  expect(body).toContain(name.replaceAll("&", "&amp;").replaceAll("<", "&lt;"))
  // A day with no menus says only what the page does
  expect((await renderedAt("/dining/", dayStart("2001-01-01"))).split("<body>")[1]).not.toContain("<h2>")
})

test("the map's shell lists the bus routes and the events of today and the week, each linking to its page", async () => {
  const { events: all } = v.parse(EventsData, events)
  const next = all.toSorted((a, b) => a.start - b.start).find(({ start }) => localDay(start) === localDay(start - HOUR))
  const body = (await renderedAt("/map/", next ? next.start - HOUR : Date.now())).split("<body>")[1]
  expect(body).toContain("Live on every Wildcat Transit route:")
  if (next) {
    expect(body).toContain("<h2>UNH events today</h2>")
    expect(body).toContain(`<a href="${urlOf({ kind: "event", id: next.id }).replaceAll("&", "&amp;")}">`)
  }
})
