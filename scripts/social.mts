// Each page's social image, which link previews show, made by hand with `npm run social` when their look should
// change, and kept in public/social/, as Workers Builds has no browser. Playwright opens the app from Vite's dev
// server with the data the inputs installed: the map's scene (src/map/social.mts) pitched over campus with a bus
// placed on its route, and the dining and laundry pages at lunchtime on a weekday, the laundry room's machines made up
// here rather than asked of the vendor. Each card is then laid out around those screenshots as a page of its own,
// drawn at twice its size, and scaled down into a small PNG

import { readFile, writeFile } from "node:fs/promises"
import { chromium, type Page } from "@playwright/test"
import sharp from "sharp"
import * as v from "valibot"
import { createServer } from "vite"
import { IMAGE, PAGES, PATHS, type Path, imageOf } from "../src/shell/pages.mts"
import { assessRoom, type Machine, type RoomLive, type Summaries } from "../src/laundry/infer.mts"
import { Usual } from "../src/laundry/model.mts"
import { HOUR, TIME_ZONE, dayStart, weekday } from "../src/shared/time.mts"
import menus from "../src/dining/menus.json" with { type: "json" }
import rooms from "../src/laundry/rooms.json" with { type: "json" }
import usualJson from "../src/laundry/usual.json" with { type: "json" }

const SCALE = 2

const server = await createServer({ logLevel: "warn", server: { hmr: false } })
await server.listen()
const origin = server.resolvedUrls!.local[0].replace(/\/$/, "")

const browser = await chromium.launch()

// Lunchtime on the first weekday the menus have, in Durham
const day = Object.keys(Object.values(menus.days)[0]).sort().find(day => weekday(day) < 5)!
const NOON = dayStart(day) + 12.3 * HOUR

/** A browser of the app, asking only the dev server, with what it remembers, and no to usage stats */
const contextOf = async (viewport: { width: number, height: number }, remembered: Record<string, string> = {}) => {
  const context = await browser.newContext({ viewport, deviceScaleFactor: SCALE, timezoneId: TIME_ZONE, colorScheme: "light" })
  await context.route(url => url.origin !== origin, route => route.abort())
  // Not in the blank page each starts on, which has no storage
  await context.addInitScript(remembered => {
    if (location.origin !== "null")
      for (const [key, value] of Object.entries(remembered))
        localStorage.setItem(key, JSON.stringify(value))
  }, { usage: "no", ...remembered })
  return context
}

/** Once a page shows what it's waited for, in its own fonts */
const settled = async (page: Page, selector: string) => {
  await page.waitForSelector(selector, { state: "attached", timeout: 60_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
}

//#region Screenshots of the app

/** The map's scene, as wide as the card and twice as dense, with the bus at a point of it */
const shootMap = async ({ left, top, along }: { left: number, top: number, along: number }) => {
  const context = await contextOf(IMAGE)
  await context.route(url => url.pathname === "/social/map", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>html, body { margin: 0 } #map { position: fixed; inset: 0 }</style><div id="map"></div><script type="module" src="/src/map/social.mts"></script>`
  }))
  const page = await context.newPage()
  // Looking south down Main Street over Thompson Hall's lawn from the Whittemore Center, the lawn in the middle of what
  // the padding leaves below and to the right, with a Gables Connector bus a share of the way along its trip
  const scene = new URLSearchParams({
    route: "Gables", along: `${along}`, lon: "-70.933", lat: "43.1375", zoom: "16.6", pitch: "38", bearing: "160", left: `${left}`, top: `${top}`
  })
  await page.goto(`${origin}/social/map?${scene}`)
  await settled(page, "body[data-ready]")
  const shot = await page.screenshot()
  await context.close()
  return shot
}

const PHONE = { width: 390, height: 844 }

// How many washers and dryers each room has, as the collector has seen
const usual = v.parse(Usual, usualJson)

/** A lunchtime's machines in a room, as the Worker would answer it, the same each time */
const roomAt = (id: string, at: number): RoomLive => {
  const [washers, dryers] = [usual.rooms[id].washer?.total ?? 0, usual.rooms[id].dryer?.total ?? 0]
  // Minutes left on each machine in turn, none for a free one, starting somewhere of the room's own
  const minutes = [12, 0, 31, 4, 0, 22, 0, 39, 17, 0, 9, 0, 26, 44]
  const offset = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0)
  const machine = (i: number): Machine => {
    const left = minutes[(i + offset) % minutes.length]
    return {
      id:        `${id}-${i + 1}`,
      room:      id,
      number:    `${i + 1}`,
      kind:      i < washers ? "washer" : "dryer",
      model:     "",
      status:    left ? "running" : "free",
      raw:       left ? "IN_USE" : "AVAILABLE",
      at:        at - 2 * 60_000,
      remaining: left * 60 + 120
    }
  }
  return { at, isStale: false, history: {}, machines: Array.from({ length: washers + dryers }, (_, i) => machine(i)) }
}

/** Every room's counts, as the Worker would answer them */
const summariesAt = (at: number): Summaries => ({
  at,
  rooms: Object.fromEntries(rooms.filter(({ id }) => id in usual.rooms).map(({ id }) => [id, { ...assessRoom(roomAt(id, at), at).summary, at }]))
})

/**
 * A page of the app on a phone at lunchtime, once it shows what's ready and anything more's done, with the laundry
 * answered here
 */
const shootPhone = async (path: string, ready: string, remembered?: Record<string, string>, then?: (page: Page) => Promise<void>) => {
  const context = await contextOf(PHONE, remembered)
  await context.route(`${origin}/api/laundry/rooms`, route => route.fulfill({ json: summariesAt(NOON) }))
  await context.route(`${origin}/api/laundry/rooms/*`, route => route.fulfill({ json: roomAt(new URL(route.request().url()).pathname.split("/").at(-1)!, NOON) }))
  const page = await context.newPage()
  await page.clock.setFixedTime(NOON)
  await page.goto(origin + path)
  await settled(page, ready)
  await then?.(page)
  const shot = await page.screenshot()
  await context.close()
  return shot
}

/** The first food with a diet's tag opened to its details, scrolled up to the halls so its nutrition shows */
const openFood = async (page: Page) => {
  await page.locator("details.food:has(.diet) summary").first().click()
  await settled(page, ".food[open] .food-details dl")
  await page.evaluate(() => scrollTo(0, document.querySelector("[aria-label=\"Dining hall\"]")!.getBoundingClientRect().top - 16))
}

//#endregion

const url = (png: Buffer) =>
  `data:image/png;base64,${png.toString("base64")}`

const shots = {
  map:       url(await shootMap({ left: 560, top: 40, along: 0.37 })),
  // Out from behind the screens, the bus nearer Thompson Hall
  besideMap:   url(await shootMap({ left: 120, top: 120, along: 0.385 })),
  holloway:  url(await shootPhone("/dining/", "main li", { "dining-hall": "holloway-commons-dining" }, openFood)),
  philbrook: url(await shootPhone("/dining/", "main li", { "dining-hall": "philbrook-dining-hall" })),
  rooms:     url(await shootPhone("/laundry/", ".count")),
  room:      url(await shootPhone("/laundry/adams-tower/", ".machine"))
}
await server.close()

//#region The cards

const icon = (await readFile(new URL("../public/icon.svg", import.meta.url), "utf8")).replace(/<style>[\s\S]*?<\/style>/, "")

/** A light theme color of the site's (base.css) */
const base = await readFile(new URL("../src/shell/base.css", import.meta.url), "utf8")
const color = (name: string) =>
  base.match(`--${name}:\\s*([^;]+);`)![1]

const CSS = `
:root {
  --paper:  ${color("surface")};
  --ink:    ${color("text")};
  --muted:  ${color("muted")};
  --border: ${color("border")};
  font-family: system-ui, -apple-system, sans-serif;
  color: var(--ink);
}
html, body {
  margin: 0;
}
body {
  position: relative;
  inline-size: ${IMAGE.width}px;
  block-size: ${IMAGE.height}px;
  overflow: hidden;
  background: var(--paper);
}

/* The map, faded into the paper toward the words and the horizon */
.map {
  position: absolute;
  inset: 0;
  background: center / cover var(--map);
  mask:
    linear-gradient(to right, transparent var(--clear), black calc(var(--clear) + 25%)) intersect,
    linear-gradient(to bottom, transparent 4%, black 36%, black 86%, transparent);
}

/* A screen of the app, floating, turned a little away */
.screen {
  position: absolute;
  inline-size: 390px;
  block-size: 844px;
  border-radius: 36px;
  background: top / 100% var(--screen);
  box-shadow:
    0 0 0 1px oklch(23% 0.03 265 / 0.07),
    0 2px 8px oklch(23% 0.03 265 / 0.08),
    0 40px 90px -20px oklch(23% 0.03 265 / 0.35);
  transform-origin: top left;
  transform: perspective(1800px) rotateY(-18deg) rotateX(8deg) rotateZ(var(--turn)) scale(var(--scale, 1));
}
.screen.behind {
  filter: brightness(0.97);
}

.words {
  position: absolute;
  inset: 64px auto 64px 96px;
  display: flex;
  flex-direction: column;
  align-items: start;
}
.brand {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 50px;
  letter-spacing: -0.02em;
  line-height: 1;
}
.brand svg {
  inline-size: 54px;
  color: var(--ink);
}
.not {
  font-weight: 500;
  color: var(--muted);
}
.unh {
  font-weight: 800;
}
.label {
  max-inline-size: 480px;
  margin: 34px 0 0;
  font-size: 66px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.02;
}
.unofficial {
  margin-block-start: auto;
  padding: 7px 16px 8px;
  border: 2px solid var(--border);
  border-radius: 999px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--paper);
}
`

const words = (label: string) => `
<div class="words">
  <div class="brand">${icon}<span><span class="not">not</span><span class="unh">unh</span></span></div>
  <p class="label">${label}</p>
  <div class="unofficial">Unofficial</div>
</div>`

/** A screen at a place on the card, turned a little, and smaller further back */
const screen = (shot: string, left: number, top: number, turn: number, scale = 1, behind = false) =>
  `<div class="screen${behind ? " behind" : ""}" style="--screen: url(${shot}); left: ${left}px; top: ${top}px; --turn: ${turn}deg; --scale: ${scale}"></div>`

/** The map, its left clear of it up to a share of the card's width, from where it fades in */
const map = (shot = shots.map, clear = 28) =>
  `<div class="map" style="--map: url(${shot}); --clear: ${clear}%"></div>`

const LAYOUTS: Record<Path, string> = {
  "/":         map(shots.besideMap, 36) + screen(shots.room, 740, 130, -4, 0.8, true) + screen(shots.philbrook, 895, 70, 3, 0.86),
  "/map/":     map(),
  "/dining/":  map(shots.besideMap, 36) + screen(shots.philbrook, 950, 40, 3, 0.78, true) + screen(shots.holloway, 725, 90, -3, 0.84),
  "/laundry/": map(shots.besideMap, 36) + screen(shots.rooms, 735, 120, -4, 0.84, true) + screen(shots.room, 862, 60, 3, 0.9)
}

const cardOf = async (page: Page, path: Path) => {
  await page.setContent(`<!doctype html><style>${CSS}</style>${LAYOUTS[path]}${words(PAGES[path].label)}`)
  await page.evaluate(() => document.fonts.ready)
  const shot = await page.screenshot()
  return sharp(shot).resize(IMAGE.width, IMAGE.height).png({ palette: true, quality: 90, effort: 10 }).toBuffer()
}

const page = await (await browser.newContext({ viewport: IMAGE, deviceScaleFactor: SCALE })).newPage()
for (const path of PATHS) {
  const card = await cardOf(page, path)
  await writeFile(new URL(`../public${imageOf(path)}`, import.meta.url), card)
  console.log(`${imageOf(path)}: ${Math.round(card.length / 1024)} kB`)
}

//#endregion

await browser.close()
