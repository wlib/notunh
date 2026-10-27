// Fetches the terms' sections from the registrar's course API, and the academic calendar from 25Live, into the files
// the pages load (src/courses/course.mts): the index, src/courses/courses.json, with the calendar and each term's
// dates and freshness, and each term's sections under public/data/courses/, named by their content so a term that
// didn't change stays cached. As the inputs are made each night (scripts/data.mts acquire):
//
//   node scripts/map/courses.mts                      fetches, politely: one request at a time, a pause between
//   node scripts/map/courses.mts --cache <folder>     reads the pages and 25Live windows from a folder where they're
//                                                     under a day old, fetching and keeping there what isn't, as
//                                                     --cache ../notunh-model-research/campus-layers-2/raw does
//
// The terms are those running or yet to start within AHEAD days whose sections the registrar has published: the live
// ones (activeTerms), J-Term included, which pages load as they're wanted, and the next, which only a course's page
// loads. 25Live is read 30 days a request around today, a window split where it answers its cap of 200, far enough
// either way to hold any such term's dates. The import fails loud (src/courses/registrar.mts), as does an unknown
// building code (src/courses/buildings.mts) and any address in the clear (src/courses/email.mts), so the last
// night's files stay
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { type CoursesIndex, type TermEntry, type TermFile, COURSES, DATA_PATH, Section, termSpan } from "../../src/courses/course.mts"
import { type Calendar, fromLive25 } from "../../src/courses/calendar.mts"
import { placeOfCode } from "../../src/courses/buildings.mts"
import { LOOKS_LIKE_EMAIL } from "../../src/courses/email.mts"
import { Page, type PageRead, coursesUrl, importTerm, pageRead } from "../../src/courses/registrar.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { live25Url } from "../../src/social/sources.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { getJson } from "../../src/shared/json.mts"
import { type Day, DAY, addDays, daysBetween, localDay } from "../../src/shared/time.mts"
import { writeInput } from "../files.mts"

/** Who's asking, as the Worker and the events say it too */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

/** Between one request and the next */
const PAUSE = 1500

/** Sections a page, as courses.unh.edu asks */
const PAGE = 100

/** 25Live's days a request, and the most entries it answers */
const WINDOW = 30
const CAP = 200

/** How far back and ahead the calendar is read: any term's dates that's published are within */
const BACK = 140
const AHEAD = 150

/** How old a cached answer may be */
const MAX_AGE = DAY

const pause = () =>
  new Promise(resolve => setTimeout(resolve, PAUSE))

const fetchJson = async (url: string) => {
  const json = await getJson(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) })
  await pause()
  return json
}

//#region Calendar

/** 25Live's entries over some days, a window split in two wherever one answers its cap */
const live25Window = async function* (from: Day, days: number): AsyncGenerator<unknown[]> {
  const entries = await fetchJson(live25Url(from, days))
  if (!Array.isArray(entries))
    throw new Error(`25Live answered ${typeof entries} for ${from}`)
  if (entries.length < CAP || days === 1)
    yield entries
  else {
    const half = Math.floor(days / 2)
    yield* live25Window(from, half)
    yield* live25Window(addDays(from, half), days - half)
  }
}

/** The calendar around today: from a cache of 25Live's windows under a day old, else from 25Live, kept there */
const calendarOf = async (today: Day, cache?: string) => {
  const cached = cache ? (await readdir(cache)).filter(name => /^25live-\d{8}(-\d+)?\.json$/.test(name)) : []
  const newest = Math.max(0, ...await Promise.all(cached.map(async name => (await stat(`${cache}/${name}`)).mtimeMs)))
  if (cache && Date.now() - newest < MAX_AGE) {
    const entries = (await Promise.all(cached.map(async name => JSON.parse(await readFile(`${cache}/${name}`, "utf8")) as unknown[]))).flat()
    return fromLive25(entries, newest)
  }
  const fetched = Date.now()
  const entries: unknown[] = []
  for (let from = addDays(today, -BACK); from < addDays(today, AHEAD); from = addDays(from, WINDOW))
    for await (const window of live25Window(from, WINDOW)) {
      entries.push(...window)
      if (cache)
        await writeFile(`${cache}/25live-${from.replaceAll("-", "")}-${window.length}.json`, JSON.stringify(window))
    }
  return fromLive25(entries, fetched)
}

//#endregion

//#region Terms

/** A term's pages: from a cache where every page is there and the oldest under a day old, else from the API, kept there */
const pagesOf = async (code: string, cache?: string): Promise<PageRead[]> => {
  if (cache) {
    const read: PageRead[] = []
    for (let offset = 0; ; offset += PAGE) {
      const file = `${cache}/courses-${code}-${offset}.json`
      const page = await readFile(file, "utf8").then(json => v.parse(Page, JSON.parse(json)), () => undefined)
      if (!page)
        break
      read.push(pageRead(page, (await stat(file)).mtimeMs))
      if (offset + PAGE >= page["total-count"]) {
        if (Date.now() - Math.min(...read.map(({ fetched }) => fetched)) < MAX_AGE)
          return read
        break
      }
    }
  }
  const read: PageRead[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = v.parse(Page, await fetchJson(coursesUrl(code, offset, PAGE)))
    read.push(pageRead(page, Date.now()))
    if (cache)
      await writeFile(`${cache}/courses-${code}-${offset}.json`, JSON.stringify(page))
    if (offset + PAGE >= page["total-count"])
      return read
  }
}

/** Whether a term's dates have it running or starting within AHEAD days, as of a Durham day */
const isAhead = (today: Day, { from, to }: { from: Day, to: Day }) =>
  today <= to && daysBetween(today, from) <= AHEAD

/**
 * The terms to fetch: those the calendar names whose dates, or a guess at the one it doesn't give, have them running
 * or starting within AHEAD days. Their sections then say for certain (termSpan)
 */
export const candidates = (calendar: Calendar, now: number) =>
  Object.entries(calendar.terms).flatMap(([code, { start, end }]) => {
    const from = start ?? (end && addDays(end, -42))
    const to = end ?? (start && addDays(start, 140))
    return from && to && isAhead(localDay(now), { from, to }) ? [code] : []
  })

/**
 * The files the pages load, from the terms imported: the sections of each term running or yet to start that has any,
 * checked once more against the schema, as a file named by its content, and the index naming them with the calendar.
 * Nothing that looks like an address may be in either
 */
export const publish = async (imported: readonly Awaited<ReturnType<typeof importTerm>>[], calendar: Calendar, now: number) => {
  const files = new Map<string, string>()
  const terms: TermEntry[] = []
  for (const { code, name, fetched, sections } of imported) {
    v.parse(v.array(Section), sections)
    const span = termSpan(code, calendar, sections)
    if (!sections.length || !isAhead(localDay(now), span))
      continue
    const json = JSON.stringify({ code, sections } satisfies TermFile)
    const file = `${DATA_PATH}${(await contentHash(json, "base64url")).slice(0, 16)}.json`
    files.set(file, json)
    terms.push({ code, name, ...span, fetched, sections: sections.length, file })
  }
  terms.sort((a, b) => a.from.localeCompare(b.from))
  const index: CoursesIndex = { built: now, calendar, terms, files: [...files.keys()] }
  if ([JSON.stringify(index), ...files.values()].some(json => LOOKS_LIKE_EMAIL.test(json)))
    throw new Error("An address is in the clear in what would ship")
  return { index, files }
}

//#endregion

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cache = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : undefined
  if (cache)
    await mkdir(cache, { recursive: true })

  const now = Date.now()
  const gazetteer = v.parse(Gazetteer, JSON.parse(await readFile(fileURLToPath(new URL("../../src/map/gazetteer.json", import.meta.url)), "utf8")))
  const place = placeOfCode(new Set(gazetteer.places.map(({ name }) => name)))
  const calendar = await calendarOf(localDay(now), cache)
  if (!calendar.noClass.length || !Object.keys(calendar.terms).length)
    throw new Error("25Live's academic calendar has no terms or no days off: has it changed its titles?")

  const imported = []
  for (const code of candidates(calendar, now))
    imported.push(await importTerm(code, await pagesOf(code, cache), place))
  const { index, files } = await publish(imported, calendar, now)

  for (const [file, json] of files)
    await writeInput(`public${file}`, json)
  await writeInput(COURSES, JSON.stringify(index) + "\n")

  console.log(`Calendar: no classes ${calendar.noClass.join(" ")}; swaps ${JSON.stringify(calendar.swaps)}; holidays ${calendar.holidays.join(" ")}`)
  for (const [code, dates] of Object.entries(calendar.terms))
    console.log(`  ${code} ${JSON.stringify(dates)}`)
  for (const term of index.terms) {
    const timed = imported.find(({ code }) => code === term.code)!.sections.flatMap(section => section.meetings).filter(meeting => meeting.days)
    console.log(`${term.code} ${term.name} ${term.from}–${term.to}: ${term.sections} sections, ${timed.length} timed meetings, ${timed.filter(meeting => meeting.place).length} placed; fetched ${new Date(term.fetched).toISOString()}; ${(files.get(term.file)!.length / 1024).toFixed(0)} KB as ${term.file}`)
  }
}
