// Downloads OpenFreeMap's Liberty style, with its sprite and the fonts the map's labels need, and makes it ours
// (src/map/basemap/style.mts), as the inputs are made each night (scripts/data.mts). It goes in a folder under
// public/data/map/ named by a hash of everything in it, so the style, sprite, and fonts the map loads always match.
// src/map/style.json names the folder; the map's page bundles it, loads the style by it, and keeps the folder
// offline. The style's tiles are OpenFreeMap's current planet build, whose URLs never change, and the inputs are made
// nightly to pick up a new build. A build keeps the folder the site serves one more build beside the new one, as the
// tiles' does, for a map tab still on it. The fixtures (tests/fixtures/make.mts) bundle a style the same way, from the
// Liberty the tests have

import { readFile } from "node:fs/promises"
import { Readable } from "node:stream"
import type { StyleSpecification, VectorSourceSpecification } from "maplibre-gl"
import { checked, getJson, objectOf } from "../../src/shared/json.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { BASE, GLYPH_RANGES, LIBERTY, STYLE_ROOT, StyleManifest, type TileJson, fontsOf, restyle } from "../../src/map/basemap/style.mts"
import { REPO, keepServed, writeInput } from "../files.mts"
import { deployed, served } from "../site.mts"

const MANIFEST = "src/map/style.json"

/** A style's folder, by path in it: its sprite and fonts as files, and the style itself */
export type StyleFolder = { folder: string, files: Map<string, Uint8Array | string>, manifest: StyleManifest }

const SPRITES = ["", "@2x"].flatMap(scale => [".json", ".png"].map(extension => `sprite${scale}${extension}`))

/** Every path in a style's folder, as URLs have them: the style, its sprite, and each font's glyph ranges */
export const pathsOf = (fonts: readonly string[]) =>
  ["style.json", ...SPRITES, ...fonts.flatMap(font => GLYPH_RANGES.map(range => `fonts/${encodeURIComponent(font)}/${range}.pbf`))]

/**
 * Liberty made ours in a folder named by a hash of its contents (the style hashed before it names the folder), with
 * the manifest the page loads it by
 */
export const bundle = async (liberty: StyleSpecification, tiles: TileJson, files: readonly (readonly [string, Uint8Array])[]): Promise<StyleFolder> => {
  const hash = await contentHash(Readable.from([JSON.stringify(restyle(liberty, tiles, "")), ...files.map(([, data]) => data)]), "base64url")
  const folder = `${STYLE_ROOT}${hash.slice(0, 16)}/`
  return {
    folder,
    files:    new Map<string, Uint8Array | string>([...files, ["style.json", JSON.stringify(restyle(liberty, tiles, folder))]]),
    manifest: { url: `${folder}style.json`, required: [`${folder}style.json`], folders: [folder] }
  }
}

const download = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`${response.status} from ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Keeps the style folder the site serves now, every file of it fetched back, beside the one installed, as a build
 * starts from nothing. Gives back how many files were kept
 */
export const keepServedStyle = async () => {
  const installed = await checked(StyleManifest, JSON.parse(await readFile(new URL(MANIFEST, REPO), "utf8")), MANIFEST)
  const serving = await deployed("/map/", "style", StyleManifest)
  const servedFolder = serving?.folders?.[0]
  const servedStyle = servedFolder && servedFolder !== installed.folders?.[0] ? await served(serving.url, objectOf<StyleSpecification>()) : undefined
  return servedStyle ? (await keepServed(pathsOf(fontsOf(servedStyle)).map(path => servedFolder + path))).length : 0
}

if (import.meta.main) {
  const liberty = await getJson<StyleSpecification>(LIBERTY)
  const { url } = liberty.sources[BASE] as VectorSourceSpecification
  const tiles = await getJson<TileJson>(url!)
  if (!tiles.tiles?.length || typeof liberty.sprite !== "string" || !liberty.glyphs)
    throw new Error("Liberty has no tiles, sprite, or fonts where expected")

  const sprite = await Promise.all(SPRITES.map(async name => [name, await download(`${liberty.sprite}${name.slice("sprite".length)}`)] as const))
  const fonts = fontsOf(restyle(liberty, tiles, "/"))
  const glyphs = await Promise.all(
    fonts.flatMap(font => GLYPH_RANGES.map(async range =>
      [`fonts/${font}/${range}.pbf`, await download(liberty.glyphs!.replace("{fontstack}", encodeURIComponent(font)).replace("{range}", range))] as const
    ))
  )
  const { folder, files, manifest } = await bundle(liberty, tiles, [...sprite, ...glyphs])
  for (const [path, data] of files)
    await writeInput(`public${folder}${path}`, data)
  await writeInput(MANIFEST, JSON.stringify(manifest) + "\n")

  const kb = (sizes: number[]) => `${Math.round(sizes.reduce((a, b) => a + b, 0) / 1024)} KB`
  console.log(`Wrote the style (${kb([files.get("style.json")!.length])}, tiles ${tiles.tiles[0]}), sprite (${kb(sprite.map(([, data]) => data.length))}), and ${fonts.length} fonts in ${GLYPH_RANGES.length} ranges (${kb(glyphs.map(([, data]) => data.length))}) to ${folder}`)
}
