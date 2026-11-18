// Reads each term's final exams (src/courses/finals.mts) from the registrar's examinations page and the spreadsheet it
// links, and stores them in the Worker, which tells them only to a device with a verified UNH address. They're kept
// out of the inputs a build installs, whose releases anyone can download, so this runs with learning, after the
// tests pass (scripts/data.mts learn), rather than as an input:
//
//   node scripts/map/finals.mts                    reads them and says what it found, storing nothing
//   node scripts/map/finals.mts --store            and stores them, merged over what's stored (--local for
//                                                  `wrangler dev`), which takes BUILD_TOKEN
//   node scripts/map/finals.mts --cache <folder>   reads the page and the sheets from a folder where they're under a
//                                                  day old, fetching and keeping there what isn't
//
// The page is read each night for the links, which change every term; a term whose schedule is "TBA" has none and
// is skipped, and what's stored for it stays. Only terms the courses index lists are read, and each is placed with its
// own sections, so the inputs being made (inputs/) or else those installed are read first. The sheet is an anonymous
// SharePoint link that answers 403 until the cookies its redirect sets are sent back, so it's fetched as a browser
// would, keeping those, one request at a time, saying who's asking; nothing more. A sheet that can't be fetched or
// read fails loud and stores nothing, so the Worker keeps the last good finals, and the Inputs job fails once the rest
// is published. A building code the table lacks is warned of, its rooms kept as written, and fails the run too

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
// Node's URL, which its fs functions take, rather than whatever global URL the typecheck sees
import { URL } from "node:url"
import { unzipSync, strFromU8 } from "fflate"
import * as v from "valibot"
import { type CoursesIndex, CoursesIndex as IndexSchema, COURSES, TermFile } from "../../src/courses/course.mts"
import { type Cell, type Finals, type TermFinals, EXAMINATIONS, FINALS, Finals as FinalsSchema, downloadUrl, fromSheet, merged, placerFor, scheduleLinks } from "../../src/courses/finals.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { DAY, localDay } from "../../src/shared/time.mts"
import { REPO, STAGED, exists } from "../files.mts"
import { readModel, writeModel } from "../worker.mts"

/** Who's asking, as every request of ours says */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

/** Between one request and the next */
const PAUSE = 1500

/** The most redirects followed to a sheet */
const REDIRECTS = 6

const pause = () =>
  new Promise(resolve => setTimeout(resolve, PAUSE))

//#region The sheet

/** XML's escapes, decoded */
const unescaped = (xml: string) =>
  xml.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, decimal?: string, hex?: string, name?: string) =>
    decimal ? String.fromCodePoint(+decimal) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" })[name!.toLowerCase()]!)

/** The text of an element's <t>s, as a shared string or an inline one holds it, runs and all */
const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(([, text]) => unescaped(text)).join("")

/** "AB" as the column it names, from 0 */
const columnOf = (letters: string) =>
  [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1

/**
 * The first sheet of an .xlsx as rows of cells, each where its reference puts it: an xlsx is a zip of XML, so it's
 * read with the zip the timetable's read with (fflate) and a few patterns, as text where it's a string, shared or
 * inline, and a number where it's a number
 */
export const sheetRows = (xlsx: Uint8Array): Cell[][] => {
  const files = unzipSync(xlsx)
  const text = (path: string) => {
    if (!files[path])
      throw new Error(`The spreadsheet has no ${path}`)
    return strFromU8(files[path])
  }
  const sheetId = text("xl/workbook.xml").match(/<sheet\s[^>]*r:id="([^"]+)"/)?.[1]
  const target = [...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)]
    .map(([tag]) => ({ id: tag.match(/\bId="([^"]+)"/)?.[1], target: tag.match(/\bTarget="([^"]+)"/)?.[1] }))
    .find(({ id }) => id === sheetId)?.target
  if (!target)
    throw new Error("The spreadsheet names no first sheet")
  const strings = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => textOf(si)) : []
  return [...text(target.startsWith("/") ? target.slice(1) : `xl/${target}`).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)].map(([, cells = ""]) => {
    const row: Cell[] = []
    for (const [, attributes, body = ""] of cells.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = columnOf(attributes.match(/\br="([A-Z]+)\d+"/)?.[1] ?? "")
      const type = attributes.match(/\bt="(\w+)"/)?.[1]
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      row[at < 0 ? row.length : at] =
        type === "s"         ? strings[Number(value)] :
        type === "inlineStr" ? textOf(body) :
        type === "str" || type === "e" || type === "b" ? (value === undefined ? undefined : unescaped(value)) :
        value === undefined  ? undefined : Number(value)
    }
    return row
  })
}

//#endregion

//#region Fetching

/** Keeps the cookies a response sets, by name, over any kept before */
const keep = (jar: Map<string, string>, response: Response) => {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";")
    const at = pair.indexOf("=")
    if (at > 0)
      jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
}

/** The cookies kept, as a request sends them back */
const cookieOf = (jar: ReadonlyMap<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ")

/**
 * A share link's file: its download, its redirects followed by hand so the cookies each sets go back with the next,
 * as any browser's would. Never a sign-in: a redirect to one, or anything but a zip at the end, fails
 */
export const fetchSheet = async (link: string, ask: typeof fetch = fetch) => {
  const jar = new Map<string, string>()
  let url = downloadUrl(link)
  for (let hops = 0; hops <= REDIRECTS; hops++) {
    const response = await ask(url, { redirect: "manual", headers: { ...HEADERS, ...jar.size && { cookie: cookieOf(jar) } }, signal: AbortSignal.timeout(60_000) })
    keep(jar, response)
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null
    if (next === null) {
      const body = new Uint8Array(await response.arrayBuffer())
      if (!response.ok || body[0] !== 0x50 || body[1] !== 0x4b)
        throw new Error(`${link} answered ${response.status} ${response.headers.get("content-type") ?? ""}, not a spreadsheet`)
      return body
    }
    url = new URL(next, url).href
    if (/login\.microsoftonline|\/_forms\/|\/_layouts\/15\/Authenticate/i.test(url))
      throw new Error(`${link} asks for a sign-in`)
    await pause()
  }
  throw new Error(`${link} redirected more than ${REDIRECTS} times`)
}

/** A cached file under a day old, else what `get` gives, kept there */
const cachedOr = async <T extends string | Uint8Array,>(cache: string | undefined, name: string, get: () => Promise<T>, read: (path: string) => Promise<T>) => {
  const path = cache && `${cache}/${name}`
  if (path && await stat(path).then(({ mtimeMs }) => Date.now() - mtimeMs < DAY, () => false))
    return read(path)
  const got = await get()
  if (path)
    await writeFile(path, got)
  return got
}

//#endregion

/** A file of the inputs being made, else as installed, by its path in the repository */
const inputOf = async (path: string) =>
  readFile(await exists(new URL(path, STAGED)) ? new URL(path, STAGED) : new URL(path, REPO), "utf8")

/**
 * Each term's finals the page links, of the terms the index lists, placed with the term's own sections; and for each,
 * how many rows and CRNs the sheet had and how many CRNs are the term's sections
 */
export const readFinals = async (index: CoursesIndex, names: ReadonlySet<string>, { cache, unknown }: { cache?: string, unknown?: (code: string, message: string) => void } = {}) => {
  const html = await cachedOr(cache, "examinations.html", async () => {
    const response = await fetch(EXAMINATIONS, { headers: HEADERS, signal: AbortSignal.timeout(60_000) })
    if (!response.ok)
      throw new Error(`${EXAMINATIONS} answered ${response.status}`)
    await pause()
    return response.text()
  }, path => readFile(path, "utf8"))
  const links = scheduleLinks(html)
  const read: Record<string, TermFinals> = {}
  const counts: { code: string, name: string, rows: number, crns: number, matched: number, sections: number }[] = []
  for (const { name, url } of links) {
    const entry = index.terms.find(term => term.name.toLowerCase() === name.toLowerCase())
    if (!entry) {
      console.log(`${name}'s finals are linked, but it isn't a term the courses list now`)
      continue
    }
    const { sections } = v.parse(TermFile, JSON.parse(await inputOf(`public${entry.file}`)))
    const xlsx = await cachedOr(cache, `finals-${(await contentHash(url)).slice(0, 12)}.xlsx`, async () => {
      const sheet = await fetchSheet(url)
      await pause()
      return sheet
    }, async path => new Uint8Array(await readFile(path)))
    const { finals, rows } = fromSheet(sheetRows(xlsx), placerFor(names, sections, error => unknown?.(error.code, error.message)))
    const crns = new Set(sections.map(({ crn }) => crn))
    read[entry.code] = { name: entry.name, source: url, fetched: Date.now(), finals }
    counts.push({ code: entry.code, name: entry.name, rows, crns: Object.keys(finals).length, matched: Object.keys(finals).filter(crn => crns.has(crn)).length, sections: sections.length })
  }
  return { read, counts, linked: links.map(({ name }) => name) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cache = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : undefined
  const isStoring = args.includes("--store")
  if (cache)
    await mkdir(cache, { recursive: true })
  if (isStoring && !process.env.BUILD_TOKEN)
    throw new Error("finals: no BUILD_TOKEN to store with")

  const index = v.parse(IndexSchema, JSON.parse(await inputOf(COURSES)))
  const gazetteer = v.parse(Gazetteer, JSON.parse(await readFile(new URL("src/map/gazetteer.json", REPO), "utf8")))
  const unplaced = new Map<string, string>()
  const { read, counts, linked } = await readFinals(index, new Set(gazetteer.places.map(({ name }) => name)), { cache, unknown: (code, message) => void unplaced.set(code, message) })

  console.log(`The examinations page links finals for ${linked.join(", ") || "no term"}`)
  for (const { code, name, rows, crns, matched, sections } of counts)
    console.log(`${code} ${name}: ${rows} rows, ${crns} CRNs, ${matched} of them among the term's ${sections} sections`)
  for (const message of unplaced.values())
    console.warn(`${message}. Its finals' rooms are kept without a place`)
  if (unplaced.size)
    process.exitCode = 1

  if (isStoring) {
    const { state, revision } = await readModel<Finals>(FINALS)
    const before = v.safeParse(FinalsSchema, state)
    const finals = merged(before.success ? before.output : undefined, read, localDay(Date.now()))
    await writeModel(FINALS, finals, revision)
    console.log(`Stored the finals of ${Object.keys(finals.terms).join(", ") || "no term"} through ${finals.through}`)
  }
}
