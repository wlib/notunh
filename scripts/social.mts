// Each page's social image, which link previews show: 1200 by 630, drawn from SVG at build in the site's colors, with
// the icon, the wordmark, and the page's heading and description. Text is drawn as the outlines of Inter's glyphs,
// laid out here, so the image is the same wherever it's built: librsvg would otherwise set it in whatever fonts the
// machine has, and Workers Builds' may have none

import { readFile } from "node:fs/promises"
import opentype, { type Font } from "opentype.js"
import sharp from "sharp"
import { ColorSpace, OKLCH, parse, serialize, sRGB, to } from "colorjs.io/fn"
import { IMAGE, PAGES, SITE, type Path } from "../src/shell/pages.mts"
import { SURFACE } from "../src/shell/theme.mts"
import { symbol } from "./icons.mts"

ColorSpace.register(sRGB)
ColorSpace.register(OKLCH)

/** A light theme color of base.css as hex, as librsvg reads no oklch() */
const css = await readFile(new URL("../src/shell/base.css", import.meta.url), "utf8")
const color = (name: string) =>
  serialize(to(parse(css.match(`--${name}:\\s*([^;]+);`)![1]), "srgb"), { format: "hex" })
const TEXT = color("text")
const MUTED = color("muted")

const fontOf = async (weight: number) =>
  opentype.parse(new Uint8Array(await readFile(new URL(import.meta.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`)))).buffer)
const [REGULAR, SEMIBOLD, BOLD] = await Promise.all([400, 600, 800].map(fontOf))

type Type = { font: Font, size: number, fill: string }

/**
 * Glyph by glyph, by their advances, without the font's substitutions, which opentype.js can't apply for Inter and
 * which plain words don't need
 */
const glyphsOf = (text: string, { font, size }: Type) => {
  let x = 0
  return [...text].map(character => {
    const glyph = font.charToGlyph(character)
    const at = x
    x += glyph.advanceWidth! * size / font.unitsPerEm
    return { glyph, at, end: x }
  })
}

const widthOf = (text: string, type: Type) =>
  glyphsOf(text, type).at(-1)?.end ?? 0

/** A line of text as a path, its baseline's left end at x and y */
const textPath = (text: string, x: number, y: number, type: Type) =>
  `<path fill="${type.fill}" d="${glyphsOf(text, type).map(({ glyph, at }) => glyph.getPath(x + at, y, type.size).toPathData(1)).join("")}"/>`

/** Words in lines no wider than width */
const wrap = (text: string, width: number, type: Type) =>
  text.split(" ").reduce<string[]>((lines, word) => {
    const last = lines.at(-1)
    if (last !== undefined && widthOf(`${last} ${word}`, type) <= width)
      lines[lines.length - 1] = `${last} ${word}`
    else
      lines.push(word)
    return lines
  }, [])

const MARGIN = 80
const WIDTH = IMAGE.width - 2 * MARGIN

export const svgOf = (path: Path) => {
  const { heading, description } = PAGES[path]
  const wordmark = { font: BOLD, size: 60, fill: TEXT }
  const not = { ...wordmark, font: SEMIBOLD, fill: MUTED }
  const title = { font: BOLD, size: 68, fill: TEXT }
  const body = { font: REGULAR, size: 34, fill: MUTED }
  const site = { font: SEMIBOLD, size: 30, fill: MUTED }
  const headingLines = wrap(heading, WIDTH, title)
  const bodyLines = wrap(description, WIDTH, body)
  // Top down: the icon and wordmark, with the address across from them, then the heading and the description
  const brand = MARGIN + 77
  const host = new URL(SITE).host
  const bodyTop = 240 + headingLines.length * 80 + 24
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE.width}" height="${IMAGE.height}" viewBox="0 0 ${IMAGE.width} ${IMAGE.height}">
  <rect width="100%" height="100%" fill="${SURFACE.light}"/>
  <g transform="translate(${MARGIN - 8} ${MARGIN - 8}) scale(${96 / 512})">${symbol}</g>
  ${textPath("not", MARGIN + 104, brand, not)}
  ${textPath("unh", MARGIN + 104 + widthOf("not", not), brand, wordmark)}
  ${textPath(host, IMAGE.width - MARGIN - widthOf(host, site), brand, site)}
  ${headingLines.map((line, index) => textPath(line, MARGIN, 240 + 64 + index * 80, title)).join("")}
  ${bodyLines.map((line, index) => textPath(line, MARGIN, bodyTop + 34 + index * 48, body)).join("")}
</svg>`
}

export const cardOf = (path: Path) =>
  sharp(Buffer.from(svgOf(path))).png().toBuffer()
