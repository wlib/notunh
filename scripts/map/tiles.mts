// Our own map tiles (src/map/tiles.mts), made with Planetiler from an OpenStreetMap extract: the base map in the
// OpenMapTiles schema Liberty draws, and the campus set in our own (campus.yml). Each set is cut to exactly the
// tiles it covers, with an empty one wherever Planetiler made none, so every tile the map asks here for is here

import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { TILES_FOLDER, TILE_SETS, type TileSetName, type TilesManifest, extentOf, tilesOf } from "../../src/map/tiles.mts"
import { exists } from "../files.mts"

/** Where the tiles are served from, each version (src/map/made.mts) in a folder of its own */
export const TILES = new URL(`../../public${TILES_FOLDER}`, import.meta.url)
/** Which version is there, bundled with the map, and empty while there's none */
export const MANIFEST = new URL("../../src/map/tiles.json", import.meta.url)

// Each set's profile: OpenMapTiles is built into Planetiler, and downloads the water and Natural Earth data it needs
const PROFILES: Record<TileSetName, (extract: string) => string[]> = {
  openmaptiles: extract => ["--download", `--osm_path=${extract}`],
  campus:       extract => [fileURLToPath(new URL("campus.yml", import.meta.url)), `--extract=${extract}`]
}

const run = (command: string, args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) =>
    spawn(command, args, { cwd, stdio: "inherit" })
      .on("error", reject)
      .on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)))
  )

/** Notes which version of the tiles is there, if any, and its folder, which the service worker keeps with the map */
export const writeManifest = (version?: string) =>
  writeFile(MANIFEST, JSON.stringify((version ? { version, folders: [`${TILES_FOLDER}${version}/`] } : {}) satisfies TilesManifest) + "\n")

/**
 * Every set's tiles for a version, from an extract, with Planetiler's jar, which keeps what it downloads beside
 * itself. Java is JAVA_HOME's, else whichever is on the path
 */
export const makeTiles = async (extract: string, jar: string, version: string) => {
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java"
  await rm(TILES, { recursive: true, force: true })
  for (const [name, set] of Object.entries(TILE_SETS) as [TileSetName, typeof TILE_SETS[TileSetName]][]) {
    const made = await mkdtemp(join(tmpdir(), `notunh-${name}-`))
    await run(java, [
      "-jar", jar, ...PROFILES[name](extract),
      `--bounds=${extentOf(set).join(",")}`, `--minzoom=${set.minzoom}`, `--maxzoom=${set.maxzoom}`,
      // Left whole, as the host compresses what it serves
      "--tile_compression=none", `--output=${made}?format=files`, "--force"
    ], dirname(jar))

    let [kept, empty, bytes] = [0, 0, 0]
    for (const [z, x, y] of tilesOf(set)) {
      const [from, to] = [pathToFileURL(join(made, `${z}/${x}/${y}.pbf`)), new URL(`${version}/${name}/${z}/${x}/${y}.pbf`, TILES)]
      await mkdir(new URL(".", to), { recursive: true })
      if (await exists(from)) {
        await copyFile(from, to)
        bytes += (await stat(to)).size
        kept++
      }
      else {
        await writeFile(to, "")
        empty++
      }
    }
    await rm(made, { recursive: true, force: true })
    console.log(`${name}: ${kept} tiles (${Math.round(bytes / 1024)} KB), and ${empty} empty`)
  }
  await writeManifest(version)
}
