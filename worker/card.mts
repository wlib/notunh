// A page's link-preview card, 1200 by 630, as the pages' own social images are (scripts/social.mts): the wordmark,
// what kind of thing it is, its title, when and where, and that it's unofficial, in the site's light colors and
// Inter, bundled, as the system font the site uses can't be. Laid out by Satori into an SVG of paths, then drawn by
// resvg, both WebAssembly the Worker bundles, so nothing is fetched to draw one. The story image a pin is shared as
// is drawn on the phone instead (src/social/story.mts), offline and within the tap that shares it

import satori, { init as initLayout } from "satori/standalone"
import { Resvg, initWasm as initResvg } from "@resvg/resvg-wasm"
import layout from "satori/yoga.wasm"
import resvg from "@resvg/resvg-wasm/index_bg.wasm"
import latin500 from "@fontsource/inter/files/inter-latin-500-normal.woff"
import latin600 from "@fontsource/inter/files/inter-latin-600-normal.woff"
import latin800 from "@fontsource/inter/files/inter-latin-800-normal.woff"
import extended500 from "@fontsource/inter/files/inter-latin-ext-500-normal.woff"
import extended600 from "@fontsource/inter/files/inter-latin-ext-600-normal.woff"
import extended800 from "@fontsource/inter/files/inter-latin-ext-800-normal.woff"
import { type Preview } from "../src/social/preview.mts"
import { IMAGE } from "../src/shell/pages.mts"
import { HOST } from "../src/shared/site.mts"
import { LIGHT, SURFACE } from "../src/shell/theme.mts"

/** Bumped when the card's look changes, so every card's address changes with it */
export const LOOK = 1

const FONTS = ([[latin500, 500], [latin600, 600], [latin800, 800], [extended500, 500], [extended600, 600], [extended800, 800]] as const)
  .map(([data, weight]) => ({ name: "Inter", data, weight, style: "normal" as const }))

// The site's icon (public/icon.svg), as its paths
const ICON = [
  "M253 53 Q256 51 259 53 C351 101 434 174 434 258 L434 454 L362 454 L362 266 C362 215 313 164 256 132 C199 164 150 215 150 266 L150 454 L78 454 L78 258 C78 174 161 101 253 53Z",
  "M268 166 C300 186 337 220 337 266 L337 437 Q337 440 334 438 L270 401 Q268 400 268 397Z"
]

type Node = { type: string, props: { style?: Record<string, unknown>, children?: Child | Child[], [prop: string]: unknown } }
type Child = Node | string

// A lone child is given as itself, as Satori takes a block's text only so
const div = (style: Record<string, unknown>, ...children: Child[]): Node =>
  ({ type: "div", props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children } })

/** Text as the fonts can draw it: without emoji, which Inter hasn't, or the spaces they leave, a time kept with its AM or PM */
export const drawable = (text: string) =>
  text.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200d\ufe0f]/gu, "").replace(/\s+/g, " ").trim().replace(/(\d) ([AP]M)\b/g, "$1\u00a0$2")

/** The title's size, smaller the longer it is, so most fit in two lines and any in three */
const titleSize = (title: string) =>
  title.length <= 18 ? 92 : title.length <= 40 ? 76 : 62

// A map pin, as the pin's own card has (scripts/pin-image.mts), beside the words
const PIN = ["M60 0c-50 0-90 40-90 90 0 70 90 150 90 150s90-80 90-150c0-50-40-90-90-90z", "M88 90a28 28 0 1 1-56 0a28 28 0 1 1 56 0z"]

/** The card of a page's preview, as Satori lays out elements */
export const cardOf = ({ kind, title, lines: [first = "", ...rest] }: Preview): Node => {
  const named = drawable(title)
  const text = { display: "block", width: "100%" }
  return div({ position: "relative", boxSizing: "border-box", width: IMAGE.width, height: IMAGE.height, flexDirection: "column", padding: "56px 96px", background: SURFACE.light, color: LIGHT.text, fontFamily: "Inter" },
    div({ position: "absolute", right: 88, top: 224 },
      { type: "svg", props: { viewBox: "-40 -10 200 260", width: 140, height: 182, children: PIN.map(d => ({ type: "path", props: { d, fill: "none", stroke: LIGHT.accent, strokeWidth: 18, strokeLinejoin: "round" } })) } }
    ),
    div({ alignItems: "center", gap: 14, fontSize: 46, letterSpacing: "-0.02em" },
      { type: "svg", props: { viewBox: "0 0 512 512", width: 50, height: 50, children: ICON.map(d => ({ type: "path", props: { d, fill: LIGHT.text } })) } },
      div({ fontWeight: 500, color: LIGHT.muted }, "not"),
      div({ fontWeight: 800, marginLeft: -14 }, "unh")
    ),
    div({ flexDirection: "column", flexGrow: 1, justifyContent: "center", width: 820, paddingBottom: 12 },
      div({ ...text, fontSize: 26, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: LIGHT.muted, marginBottom: 14, lineClamp: 1 }, drawable(kind)),
      div({ ...text, fontSize: titleSize(named), fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.06, lineClamp: 3 }, named),
      ...first ? [div({ ...text, marginTop: 24, fontSize: 40, fontWeight: 600, lineHeight: 1.2, lineClamp: 2 }, drawable(first))] : [],
      ...rest.length ? [div({ ...text, marginTop: 6, fontSize: 36, fontWeight: 500, color: LIGHT.muted, lineClamp: 1 }, drawable(rest.join(" · ")))] : []
    ),
    div({ alignItems: "center", gap: 24 },
      div({ padding: "6px 16px 7px", border: `2px solid ${LIGHT.border}`, borderRadius: 999, fontSize: 22, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: LIGHT.muted }, "Unofficial"),
      div({ fontSize: 26, fontWeight: 500, color: LIGHT.muted }, HOST)
    )
  )
}

// Each WebAssembly module is started once in the isolate, on the first card
let started: Promise<unknown> | undefined

/** A preview's card as a PNG */
export const render = async (preview: Preview) => {
  started ??= Promise.all([initLayout(layout), initResvg(resvg)])
  await started
  const svg = await satori(cardOf(preview), { ...IMAGE, fonts: FONTS })
  return new Resvg(svg).render().asPng()
}
