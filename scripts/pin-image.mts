// The link-preview image the pin page names as built (p/index.html.tsx): a 1200 by 630 card saying what a pin is,
// made by hand with `node scripts/pin-image.mts` and kept in public/social/ like the pages' own. A pin's own page is
// headed with a card of its own (worker/preview.mts), so this is only what the page says of no pin in particular

import { writeFile } from "node:fs/promises"
import sharp from "sharp"
import { IMAGE } from "../src/shell/pages.mts"
import { SURFACE } from "../src/shell/theme.mts"

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE.width}" height="${IMAGE.height}" viewBox="0 0 ${IMAGE.width} ${IMAGE.height}">
  <rect width="100%" height="100%" fill="${SURFACE.light}"/>
  <text x="80" y="150" font-family='${FONT}' font-size="64" font-weight="500" fill="#6b7280">not<tspan font-weight="800" fill="#23262e">unh</tspan></text>
  <text x="80" y="330" font-family='${FONT}' font-size="88" font-weight="800" fill="#23262e" letter-spacing="-2">A pin on the UNH map</text>
  <text x="80" y="420" font-family='${FONT}' font-size="44" font-weight="500" fill="#6b7280">A place and a time, with directions and a reminder to leave</text>
  <g transform="translate(980 440)" fill="none" stroke="#2f4f9e" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M60 0c-50 0-90 40-90 90 0 70 90 150 90 150s90-80 90-150c0-50-40-90-90-90z"/>
    <circle cx="60" cy="90" r="28"/>
  </g>
  <text x="80" y="560" font-family='${FONT}' font-size="32" fill="#6b7280">notunh.app · independent of UNH</text>
</svg>`

await writeFile(new URL("../public/social/pin.png", import.meta.url), await sharp(Buffer.from(svg)).png().toBuffer())
console.log(`public/social/pin.png, ${IMAGE.width} by ${IMAGE.height}`)
