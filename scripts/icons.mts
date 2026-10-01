// Renders the app icons from public/icon.svg: its blue symbol on white at each size the manifest and iOS ask for,
// and a maskable icon with the symbol inside the central safe circle

import { readFile, writeFile } from "node:fs/promises"
import sharp from "sharp"

const master = (await readFile(new URL("../public/icon.svg", import.meta.url), "utf8"))
  .replace(/<style>[\s\S]*?<\/style>/, "")
  .replace('fill="currentColor"', 'fill="#073482"')
for (const size of [180, 192, 512]) {
  const png = await sharp(Buffer.from(master)).resize(size, size).flatten({ background: "white" }).png().toBuffer()
  await writeFile(new URL(`../public/icon-${size}.png`, import.meta.url), png)
}

// At 74% the symbol fits inside the maskable safe zone, a circle 80% across
const symbol = master.replace(/<svg[^>]*>|<\/svg>/g, "")
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="white"/>
  <g transform="translate(66.56 66.56) scale(.74)">${symbol}</g>
</svg>`
await writeFile(
  new URL("../public/icon-512-maskable.png", import.meta.url),
  await sharp(Buffer.from(maskable)).png().toBuffer()
)
