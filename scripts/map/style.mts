// Downloads OpenFreeMap's Liberty style, with its sprite and the fonts the map's labels need, and makes it ours
// (src/map/style.mts) in a folder under public/data/map/ named by a hash of everything in it, so the style, sprite,
// and fonts the map loads always match, with the folder named in src/map/style.json, which the map's page bundles
// and loads the style by, and keeps the folder with. Its tiles are the planet build current now, whose URLs never
// change. The site rebuilds nightly to pick up a new build. With --if-missing, a style already there is kept.
// The fixtures (tests/fixtures/make.mts) bundle a style the same way, from the Liberty the tests have

import { createHash } from "node:crypto"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import type { StyleSpecification, VectorSourceSpecification } from "maplibre-gl"
import { getJson } from "../../src/shared/json.mts"
import { BASE, GLYPH_RANGES, LIBERTY, STYLE_ROOT, type StyleManifest, type TileJson, fontsOf, restyle } from "../../src/map/style.mts"
import { isKept } from "../files.mts"

const PUBLIC = new URL("../../public/", import.meta.url)
const ROOT = new URL(`.${STYLE_ROOT}`, PUBLIC)
// Written last, so it only ever names a folder with everything in it
const MANIFEST = new URL("../../src/map/style.json", import.meta.url)

/** A style's folder, by path in it: its sprite and fonts as files, and the style itself */
export type StyleFolder = { folder: string, files: Map<string, Uint8Array | string>, manifest: StyleManifest }

/**
 * Liberty made ours in a folder named by what's in it, the style taken as it is before it names the folder, with
 * the manifest the page loads it by
 */
export const bundle = (liberty: StyleSpecification, tiles: TileJson, files: Iterable<readonly [string, Uint8Array]>): StyleFolder => {
  const hash = createHash("sha256").update(JSON.stringify(restyle(liberty, tiles, "")))
  for (const [, data] of files)
    hash.update(data)
  const folder = `${STYLE_ROOT}${hash.digest("base64url").slice(0, 16)}/`
  return {
    folder,
    files:    new Map<string, Uint8Array | string>([...files, ["style.json", JSON.stringify(restyle(liberty, tiles, folder))]]),
    manifest: { url: `${folder}style.json`, folders: [folder] }
  }
}

const download = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`${response.status} from ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

if (import.meta.main && !await isKept(MANIFEST)) {
  const liberty = await getJson<StyleSpecification>(LIBERTY)
  const { url } = liberty.sources[BASE] as VectorSourceSpecification
  const tiles = await getJson<TileJson>(url!)
  if (!tiles.tiles?.length || typeof liberty.sprite !== "string" || !liberty.glyphs)
    throw new Error("Liberty has no tiles, sprite, or fonts where expected")

  const sprite = await Promise.all(
    ["", "@2x"].flatMap(scale => [".json", ".png"].map(async extension =>
      [`sprite${scale}${extension}`, await download(`${liberty.sprite}${scale}${extension}`)] as const
    ))
  )
  const fonts = fontsOf(restyle(liberty, tiles, "/"))
  const glyphs = await Promise.all(
    fonts.flatMap(font => GLYPH_RANGES.map(async range =>
      [`fonts/${font}/${range}.pbf`, await download(liberty.glyphs!.replace("{fontstack}", encodeURIComponent(font)).replace("{range}", range))] as const
    ))
  )
  const { folder, files, manifest } = bundle(liberty, tiles, [...sprite, ...glyphs])

  // Styles from earlier runs are folders named like this one; the tiles beside them are another step's
  for (const entry of await readdir(ROOT, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory() && /^[\w-]{16}$/.test(entry.name) && `${STYLE_ROOT}${entry.name}/` !== folder)
      await rm(new URL(`${entry.name}/`, ROOT), { recursive: true })

  for (const [path, data] of files) {
    const file = new URL(`.${folder}${path}`, PUBLIC)
    await mkdir(new URL(".", file), { recursive: true })
    await writeFile(file, data)
  }
  await writeFile(MANIFEST, JSON.stringify(manifest) + "\n")

  const kb = (sizes: number[]) => `${Math.round(sizes.reduce((a, b) => a + b, 0) / 1024)} KB`
  console.log(`Wrote the style (${kb([files.get("style.json")!.length])}, tiles ${tiles.tiles[0]}), sprite (${kb(sprite.map(([, data]) => data.length))}), and ${fonts.length} fonts in ${GLYPH_RANGES.length} ranges (${kb(glyphs.map(([, data]) => data.length))}) to ${folder}`)
}
