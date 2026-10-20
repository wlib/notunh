// Required generated sources, shared by fixture and production installation.
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

export const INPUT_SOURCES = ["src/map/gtfs.json", "src/map/model.json", "src/map/style.json", "src/dining/menus.json", "src/laundry/rooms.json", "src/laundry/usual.json"]

/** Reject incomplete bundles before existing files can conceal what's missing. */
export const validateInputs = async (folder: string, production = false) => {
  const json = async (path: string) => JSON.parse(await readFile(join(folder, path), "utf8"))
  for (const path of INPUT_SOURCES)
    await json(path)
  const requirePublic = async (url: string) => {
    if (!url.startsWith("/data/") || url.includes(".."))
      throw new Error(`Invalid input asset ${url}`)
    if (!(await stat(join(folder, "public", url))).isFile())
      throw new Error(`Missing input asset ${url}`)
  }
  if (production && !(await stat(join(folder, "src/map/gtfs.zip"))).isFile())
    throw new Error("Missing original GTFS archive")
  const style = await json("src/map/style.json")
  for (const url of style.required)
    await requirePublic(url)
  const dining = await json("src/dining/menus.json")
  for (const file of dining.files)
    await requirePublic(file)
}


/** Validate before removing old sources, then install only the generation's files with their parent directories. */
export const installInputBundle = async (folder: string, to: string, production: boolean, paths?: readonly string[]) => {
  await validateInputs(folder, production)
  await rm(join(to, "public/data"), { recursive: true, force: true })
  for (const path of INPUT_SOURCES) await rm(join(to, path), { force: true })
  if (paths)
    for (const path of paths) {
      await mkdir(dirname(join(to, path)), { recursive: true })
      await cp(join(folder, path), join(to, path))
    }
  else await cp(folder, to, { recursive: true })
}
