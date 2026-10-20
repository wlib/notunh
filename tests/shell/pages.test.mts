import { test, expect } from "vitest"
import fc from "fast-check"
import sharp from "sharp"
import { readFile } from "node:fs/promises"
import { buildOf } from "../../src/shell/manifest.mts"
import { IMAGE, PAGES, PATHS, SITE, imageOf, scriptJson, type Path } from "../../src/shell/pages.mts"

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

test("each page's title names the app, and its description fits a search result", () => {
  for (const { title, description } of Object.values(PAGES)) {
    expect(title).toContain("notunh")
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

test("each page's structured data parses, with what Google reads: the site's name on the home page, and each app", () => {
  for (const path of PATHS) {
    const json = headOf(rendered[path]).match(/<script type="application\/ld\+json">([^<]*)<\/script>/)![1]
    const things = JSON.parse(json)
    const app = things.find((thing: { "@type": string }) => thing["@type"] === "WebApplication")
    expect(app, path).toMatchObject({
      "@context":          "https://schema.org",
      url:                 SITE + path,
      operatingSystem:     "Any",
      isAccessibleForFree: true,
      offers:              { "@type": "Offer", price: 0 },
      author:              { "@type": "Person", name: "Daniel Ethridge" }
    })
    expect(app.name && app.description && app.applicationCategory, path).toBeTruthy()
    const site = things.find((thing: { "@type": string }) => thing["@type"] === "WebSite")
    if (path === "/")
      expect(site).toMatchObject({ name: "notunh", alternateName: ["not unh", "notUNH"], url: `${SITE}/` })
    else
      expect(site, path).toBeUndefined()
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
