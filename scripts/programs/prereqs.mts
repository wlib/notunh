// Reads every Durham course's prerequisites and every Durham program's course lists from UNH's catalog
// (src/programs/catalog.mts, requirements.mts) into the files the course page loads for its Needs and Unlocks lines
// and a program's view loads for its courses, named by their contents under public/data/programs/, and the index
// naming them, src/programs/prereqs.json, as the inputs are made nightly (scripts/data.mts). The catalog changes
// about once a year, so it's read once a week, or sooner once its year turns: on other nights the one page that says
// the year is fetched, and the files the site serves are kept as they are:
//
//   node scripts/programs/prereqs.mts              fetches the index of subjects, and if the site serves a reading of
//                                                  this catalog year under a week old, keeps its files; else each
//                                                  Durham subject's page, then the site's map and each Durham
//                                                  program's page, one at a time a second apart, into
//                                                  extract/catalog/, where a page fetched within the day is read again
//                                                  rather than fetched, so a run that failed resumes
//   node scripts/programs/prereqs.mts --fresh      reads the whole catalog tonight whatever the site serves
//   node scripts/programs/prereqs.mts --from <dir> [--programs <dir>]
//                                                  reads subjects' pages, and programs' pages, already fetched in
//                                                  folders, fetching nothing; without --programs, no programs
//
// Only the catalog's site map, course-description pages and programs' pages are asked for, as its robots.txt allows.
// The step fails, leaving the last night's files, if less than 97% of the prerequisite sentences read for sure, fewer
// than 200 programs are found, or less than half their course lists read, as a change in the catalog's markup would make

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { contentHash } from "../../src/shared/hash.mts"
import { HOUR } from "../../src/shared/time.mts"
import { INDEX_URL, SITEMAP, isAllowed, isDurham, pageOf, prerequisitesOf, programUrlsOf, subjectsOf, yearOf } from "../../src/programs/catalog.mts"
import { DATA_PATH, PREREQS, type Prereqs, PrereqsIndex } from "../../src/programs/prereqs.mts"
import { type Program, type Programs } from "../../src/programs/program.mts"
import { programOf, withTitles } from "../../src/programs/requirements.mts"
import { REPO, writeInput } from "../files.mts"
import { ORIGIN, deployed } from "../site.mts"

/** Who's asking, as the other fetches say it too (scripts/map/events.mts) */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

/** The least share of prerequisite sentences read for sure that's a catalog this still understands */
const COVERAGE = 0.97
/** The least share of programs whose course lists read for sure, and the fewest programs, likewise */
const PROGRAMS_READ = 0.5
const FEWEST_PROGRAMS = 200

const CACHE = fileURLToPath(new URL("extract/catalog/", REPO))
/** How long a page fetched before is read again rather than fetched */
const FRESH_MS = 24 * HOUR
/** How long a reading of the catalog serves before it's read again, an hour short of a week so a nightly run reads it weekly */
const SERVES_MS = 7 * 24 * HOUR - HOUR
const PAUSE_MS = 1000
const TRIES = 3

/** When the catalog was last asked for anything, so each request waits a second past the one before */
let asked = 0

/** A catalog page's HTML, from the cache if it's fresh, else fetched politely, tried a few times */
const page = async (url: string, file: string) => {
  if (!isAllowed(url))
    throw new Error(`Not a page this reads: ${url}`)
  const cached = await stat(file).catch(() => undefined)
  if (cached && Date.now() - cached.mtimeMs < FRESH_MS)
    return { html: await readFile(file, "utf8"), fetched: cached.mtimeMs, wasCached: true }
  for (let attempt = 1; ; attempt++) {
    await sleep(asked + PAUSE_MS - Date.now())
    asked = Date.now()
    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) })
      if (!response.ok)
        throw new Error(`${response.status} from ${url}`)
      const html = await response.text()
      await writeFile(file, html)
      return { html, fetched: Date.now(), wasCached: false }
    }
    catch (error) {
      if (attempt === TRIES)
        throw error
      console.warn(`Fetching ${url} again: ${error instanceof Error ? error.message : error}`)
      asked += PAUSE_MS * 5 ** attempt
    }
  }
}

/** The index of subjects, fetched, which says the catalog's year */
const fetchIndex = async () => {
  await mkdir(CACHE, { recursive: true })
  return page(INDEX_URL, join(CACHE, "index.html"))
}

/**
 * The reading the site serves, kept as the inputs if it's of this catalog year and under a week old: its index and
 * every file it names, fetched back from the site. False if it's to be read afresh
 */
const keepServed = async (year: string) => {
  const served = await deployed("/map/", "prereqs", PrereqsIndex)
  if (!served?.year || served.year !== year || Date.now() - served.fetched >= SERVES_MS)
    return false
  for (const url of served.files) {
    const response = await fetch(ORIGIN + url)
    if (!response.ok)
      throw new Error(`${response.status} fetching ${url} back from the site`)
    await writeInput(`public${url}`, new Uint8Array(await response.arrayBuffer()))
  }
  await writeInput(PREREQS, JSON.stringify(served) + "\n")
  console.log(`Kept the ${served.files.length} files of the ${year} catalog as read ${Math.round((Date.now() - served.fetched) / HOUR)} hours ago, which the site serves`)
  return true
}

/** Every Durham subject's page, fetched one at a time, with when the oldest was fetched */
const fetchPages = async (index: Awaited<ReturnType<typeof fetchIndex>>) => {
  const pages = []
  let fetched = index.fetched
  for (const { url, title } of subjectsOf(index.html).filter(subject => isDurham(subject.title))) {
    const { html, fetched: at, wasCached } = await page(url, join(CACHE, `${url.split("/").at(-2)}.html`))
    if (wasCached)
      console.log(`${title} as fetched before`)
    pages.push(pageOf(html))
    fetched = Math.min(fetched, at)
  }
  return { pages, fetched }
}

/** Every Durham program's page the site's map lists, fetched one at a time, with when the oldest was fetched */
const fetchPrograms = async () => {
  await mkdir(join(CACHE, "programs"), { recursive: true })
  const sitemap = await page(SITEMAP, join(CACHE, "sitemap.xml"))
  const pages: Program[] = []
  let fetched = sitemap.fetched
  for (const url of programUrlsOf(sitemap.html)) {
    const slug = url.split("/").at(-2)!
    const { html, fetched: at } = await page(url, join(CACHE, "programs", `${slug}.html`))
    const program = programOf(html, slug)
    if (program)
      pages.push(program)
    fetched = Math.min(fetched, at)
  }
  return { pages, fetched }
}

/** Every program's page already in a folder, Durham's read */
export const readPrograms = async (folder: string) => {
  const files = (await readdir(folder)).filter(name => name.endsWith(".html")).sort()
  const read = await Promise.all(files.map(async name => programOf(await readFile(join(folder, name), "utf8"), name.slice(0, -".html".length))))
  return read.filter(program => program !== undefined)
}

/** Every subject's page already in a folder, with when the oldest was fetched */
export const readPages = async (folder: string) => {
  const files = (await readdir(folder)).filter(name => name.endsWith(".html") && name !== "index.html")
  const read = await Promise.all(files.map(async name => ({ html: await readFile(join(folder, name), "utf8"), at: (await stat(join(folder, name))).mtimeMs })))
  return { pages: read.map(({ html }) => pageOf(html)), fetched: Math.min(...read.map(({ at }) => at)) }
}

/** A file a page loads, named by its content */
const named = async (data: unknown) => {
  const json = JSON.stringify(data)
  return { file: `${DATA_PATH}${(await contentHash(json, "base64url")).slice(0, 16)}.json`, json }
}

/**
 * The prerequisites and the programs as the files a page loads, each named by its content, and the index naming
 * them: the prerequisites, the list of programs, and each program's own
 */
export const publishPrereqs = async (data: Prereqs, programs: readonly Program[] = [], year?: string) => {
  const prereqs = await named(data)
  const files = new Map([[prereqs.file, prereqs.json]])
  if (!programs.length) {
    const index: PrereqsIndex = { fetched: data.fetched, ...year && { year }, file: prereqs.file, files: [...files.keys()] }
    return { files, index }
  }
  const each = await Promise.all(programs.map(named))
  const courses: Programs["courses"] = {}
  programs.forEach((program, i) => {
    for (const code of program.courses)
      (courses[code] ??= []).push(i)
  })
  const list = await named({
    fetched:  data.fetched,
    programs: programs.map(({ slug, title, kind }, i) => ({ slug, title, kind, file: each[i].file })),
    courses
  } satisfies Programs)
  for (const { file, json } of [list, ...each])
    files.set(file, json)
  const index: PrereqsIndex = { fetched: data.fetched, ...year && { year }, file: prereqs.file, programs: list.file, files: [...files.keys()] }
  return { files, index }
}

if (import.meta.main) {
  const from = process.argv.indexOf("--from")
  const programsFrom = process.argv.indexOf("--programs")
  const index = from < 0 ? await fetchIndex() : undefined
  const year = index ? yearOf(index.html) : undefined
  if (index && !process.argv.includes("--fresh") && year && await keepServed(year))
    process.exit(0)
  const { pages, fetched } = index ? await fetchPages(index) : await readPages(process.argv[from + 1])
  const { data, coverage } = prerequisitesOf(pages, Math.round(fetched))

  const share = coverage.read / coverage.withPrerequisites
  console.log(`${coverage.courses} Durham courses, ${coverage.withPrerequisites} with prerequisites, ${coverage.read} read for sure (${(100 * share).toFixed(1)}%, ${coverage.fixed} fixed by hand), ${coverage.dangling} references to courses not in the catalog kept as text`)
  if (coverage.unread.length)
    console.log(`Kept whole as text: ${coverage.unread.join(", ")}`)
  if (!(share >= COVERAGE))
    throw new Error(`Only ${(100 * share).toFixed(1)}% of prerequisites read for sure, under ${100 * COVERAGE}%: has the catalog's markup changed?`)

  const read = from < 0 ? (await fetchPrograms()).pages : programsFrom < 0 ? [] : await readPrograms(process.argv[programsFrom + 1])
  const titles = new Map(pages.filter(page => isDurham(page.title)).flatMap(page => page.courses.map(course => [course.code, course.title] as const)))
  const programs = withTitles(read, data, titles)
  if (from < 0 || programsFrom >= 0) {
    const sure = programs.filter(program => program.rows).length
    console.log(`${programs.length} Durham programs, ${sure} with course lists read for sure; the rest list the courses they name`)
    if (programs.length < FEWEST_PROGRAMS || !(sure / programs.length >= PROGRAMS_READ))
      throw new Error(`Only ${programs.length} programs, ${sure} read for sure: has the catalog's markup changed?`)
  }

  const published = await publishPrereqs(data, programs, year || programs[0]?.year)
  for (const [file, json] of published.files)
    await writeInput(`public${file}`, json)
  await writeInput(PREREQS, JSON.stringify(published.index) + "\n")
  console.log(`Wrote ${Object.keys(data.courses).length} courses' prerequisites and ${programs.length} programs, ${published.files.size} files, ${[...published.files.values()].reduce((sum, json) => sum + json.length, 0)} bytes`)
}
