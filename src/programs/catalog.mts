// Reading UNH's undergraduate catalog (catalog.unh.edu) for prerequisites: its course-description pages, one per
// subject, each course a div.courseblock with labelled fields, one of them "Prerequisite(s)"; and its programs'
// pages, which requirements.mts reads. Only Durham's subjects and programs are read, never those of Professional
// Studies, online or in Manchester. The catalog's robots.txt disallows /search/, /ribbit/, and /archives/, so only
// the site's map, the description pages and the programs' are ever asked for (isAllowed)

import { type Req, coursesIn, parseReq, resolved } from "./req.mts"
import type { Prereqs } from "./prereqs.mts"
import { FIXES } from "./fixes.mts"

export const CATALOG = "https://catalog.unh.edu"

/** The page listing every subject's course descriptions */
export const INDEX_URL = `${CATALOG}/undergraduate/course-descriptions/`

/** The site's map, which lists every program's page */
export const SITEMAP = `${CATALOG}/sitemap.xml`

/** A Durham program's page: a department's program under a college's programs of study, not Professional Studies' */
const PROGRAM = /^https:\/\/catalog\.unh\.edu\/undergraduate\/(?!professional-studies\/)[a-z-]+\/programs-study\/[a-z-]+\/[a-z-]+\/$/

/**
 * Whether a URL is one this reads: the site's map, the index of subjects, a subject's descriptions, or a Durham
 * program's page, and nothing else of the site
 */
export const isAllowed = (url: string) =>
  url === SITEMAP || PROGRAM.test(url) || /^https:\/\/catalog\.unh\.edu\/undergraduate\/course-descriptions\/(?:[a-z]+\/)?$/.test(url)

/** The pages of Durham's programs the site's map lists */
export const programUrlsOf = (sitemap: string) =>
  [...new Set([...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, url]) => url.trim()).filter(url => PROGRAM.test(url)))]

/**
 * Subjects taught only in Manchester or only online whose pages don't say so, unlike those the catalog marks CPSO,
 * CPSM, or UNHM. Each is required only by Professional Studies' programs, and none had a Durham section from fall
 * 2026 to spring 2027
 */
const ELSEWHERE = new Set(["ASL", "BIOT", "BSCI", "BUS", "CA", "CMPL", "COMP", "DAT", "DATA", "ET", "HRT", "INTR", "NPSY", "PM", "PS", "PTC", "SOSC"])

/** A subject's code from its title, as "Computer Science (CS)" */
const subjectOf = (title: string) =>
  title.match(/\(([A-Z]{2,5})\)/)?.[1]

/** Whether a subject, by its page's title, is taught in Durham */
export const isDurham = (title: string) => {
  const subject = subjectOf(title)
  return subject !== undefined && !/\b(?:CPS[OM]|UNHM)\b/.test(title) && !ELSEWHERE.has(subject)
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'" }

/** An HTML fragment's text, entities decoded and whitespace collapsed, zero-width spaces gone */
export const textOf = (html: string) =>
  html
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (entity, decimal, hex, name) =>
      decimal || hex ? String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16)) : ENTITIES[name] ?? entity)
    .replace(/​/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** The catalog's year a page is of, like "2026-2027", from its title */
export const yearOf = (html: string) =>
  html.match(/(\d{4}-\d{4}) (?:Undergraduate )?(?:Academic )?Catalog/)?.[1] ?? ""

/** The subjects the index lists, each with its page's URL and title */
export const subjectsOf = (html: string) =>
  [...html.matchAll(/<a href="(\/undergraduate\/course-descriptions\/[a-z]+\/)">([^<]*)<\/a>/g)]
    .map(([, path, title]) => ({ url: CATALOG + path, title: textOf(title) }))
    .filter(({ url }, i, all) => all.findIndex(other => other.url === url) === i)

/** A course as its description page gives it: its code, its title, and its prerequisites' sentence if it has one */
export type CatalogCourse = { code: string, title: string, prerequisites?: string }

/** A subject's page: its title, and each of its courses */
export const pageOf = (html: string) => ({
  title:   textOf(html.match(/<h1 class="page-title">([\s\S]*?)<\/h1>/)?.[1] ?? ""),
  courses: html.split('<div class="courseblock">').slice(1).flatMap((block): CatalogCourse[] => {
    const [, code, title] = textOf(block.match(/courseblocktitle[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "").match(/^([A-Z]{2,5} \d{3}[A-Z]{0,2}) - (.*)$/) ?? []
    if (!code)
      return []
    const field = [...block.matchAll(/courseblockextra[^>]*><strong>([^<]*)<\/strong>([\s\S]*?)<\/p>/g)]
      .find(([, label]) => /^Prerequisite/i.test(label.trim()))
    const prerequisites = field && textOf(field[2]).replace(/\.$/, "")
    return [prerequisites ? { code, title, prerequisites } : { code, title }]
  })
})

/** A course's prerequisites' sentence, or its fix (fixes.mts), read into its tree, or undefined if unsure */
export const readPrerequisites = (code: string, sentence: string) =>
  parseReq(FIXES[code]?.from === sentence ? FIXES[code].to : sentence)

/** How much of the catalog read for sure, which the build checks so a change in its markup can't pass unseen */
export type Coverage = { courses: number, withPrerequisites: number, read: number, fixed: number, unread: string[], dangling: number }

/**
 * Every Durham course's needs, each sentence read into its tree, or kept whole as text if it can't be read for sure,
 * with any course it names outside the catalog, retired or taught elsewhere, kept as text too, and every course's
 * unlocks, the courses naming it, the one exactly the other read backwards
 */
export const prerequisitesOf = (pages: { title: string, courses: CatalogCourse[] }[], fetched: number) => {
  const courses = pages.filter(page => isDurham(page.title)).flatMap(page => page.courses)
  const known = new Set(courses.map(course => course.code))
  const coverage: Coverage = { courses: courses.length, withPrerequisites: 0, read: 0, fixed: 0, unread: [], dangling: 0 }
  const needs = new Map<string, Req>()
  for (const { code, prerequisites } of courses) {
    if (!prerequisites)
      continue
    coverage.withPrerequisites++
    const tree = readPrerequisites(code, prerequisites)
    if (tree) {
      coverage.read++
      if (FIXES[code]?.from === prerequisites)
        coverage.fixed++
      coverage.dangling += coursesIn(tree).filter(course => !known.has(course)).length
    }
    else
      coverage.unread.push(code)
    needs.set(code, tree ? resolved(tree, course => known.has(course)) : { text: prerequisites })
  }
  return { data: { fetched, courses: withUnlocks(needs) } satisfies Prereqs, coverage }
}

/** Courses' needs, each course with the courses naming it among theirs, in code order, as Prereqs' courses */
export const withUnlocks = (needs: ReadonlyMap<string, Req>): Prereqs["courses"] => {
  const unlocks = new Map<string, Set<string>>()
  for (const [code, tree] of needs)
    for (const course of coursesIn(tree))
      unlocks.set(course, (unlocks.get(course) ?? new Set<string>()).add(code))
  const courses: Prereqs["courses"] = {}
  for (const code of [...new Set([...needs.keys(), ...unlocks.keys()])].sort(byCode)) {
    const tree = needs.get(code)
    const after = unlocks.get(code)
    courses[code] = { ...tree ? { needs: tree } : {}, ...after ? { unlocks: [...after].sort(byCode) } : {} }
  }
  return courses
}

/** Codes in order by subject, then number */
export const byCode = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true })
