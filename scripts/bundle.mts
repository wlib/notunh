// What a generation of the inputs holds, checked the same way for the fixtures and for production, and installed in
// place of what was. Every generation has the sources, and those made since the campus pages also have the later ones,
// each an index, a few naming files under public/data/ as `files`, which must all be there too
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { EVENTS } from "../src/social/sources.mts"
import { COURSES } from "../src/courses/course.mts"
import { PREREQS } from "../src/programs/prereqs.mts"
import { PARKING } from "../src/parking/sources.mts"

export const INPUT_SOURCES = ["src/map/gtfs.json", "src/map/model.json", "src/map/style.json", "src/dining/menus.json", "src/laundry/rooms.json", "src/laundry/usual.json"]

/** What generations made before the campus pages lack: today's events, the courses, the prerequisites, and parking */
export const LATER_SOURCES = [EVENTS, COURSES, PREREQS, PARKING]

const exists = (path: string) =>
  stat(path).then(stats => stats.isFile(), () => false)

/** The files under public/ a data file names as `files`, as the service worker keeps them with it */
export const namedBy = (json: unknown): string[] => {
  const { files } = Object(json) as { files?: unknown }
  return Array.isArray(files) ? files.filter(file => typeof file === "string") : []
}

/** Reject incomplete bundles before existing files can conceal what's missing. */
export const validateInputs = async (folder: string, production = false) => {
  const json = async (path: string) => JSON.parse(await readFile(join(folder, path), "utf8"))
  for (const path of INPUT_SOURCES)
    await json(path)
  const requirePublic = async (url: string) => {
    if (!url.startsWith("/data/") || url.includes(".."))
      throw new Error(`Invalid input asset ${url}`)
    if (!(await exists(join(folder, "public", url))))
      throw new Error(`Missing input asset ${url}`)
  }
  if (production && !(await exists(join(folder, "src/map/gtfs.zip"))))
    throw new Error("Missing original GTFS archive src/map/gtfs.zip")
  const style = await json("src/map/style.json")
  for (const url of style.required)
    await requirePublic(url)
  for (const path of ["src/dining/menus.json", ...LATER_SOURCES])
    if (path === "src/dining/menus.json" || await exists(join(folder, path)))
      for (const url of namedBy(await json(path)))
        await requirePublic(url)
}


/** Validate before removing old sources, then install only the generation's files with their parent directories. */
export const installInputBundle = async (folder: string, to: string, production: boolean, paths?: readonly string[]) => {
  await validateInputs(folder, production)
  await rm(join(to, "public/data"), { recursive: true, force: true })
  for (const path of [...INPUT_SOURCES, ...LATER_SOURCES]) await rm(join(to, path), { force: true })
  if (paths)
    for (const path of paths) {
      await mkdir(dirname(join(to, path)), { recursive: true })
      await cp(join(folder, path), join(to, path))
    }
  else await cp(folder, to, { recursive: true })
}
