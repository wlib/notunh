// Finds leads (src/social/leads.mts): passages on UNH's pages in Durham that say when something happens, which the
// calendars don't tell. Crawls each section of SEEDS breadth first, within its host and path, to a depth, as unh.edu's
// sitemap lists little more than people: two at a time with a pause between, as robots.txt allows, asking again only
// for what changed (ETag, Last-Modified) since the last run, whose answers are kept in node_modules/.cache. A host that
// answers with a challenge or a sign-in is left alone. Then each page's <main> is read into leads, those of passages
// judged before (leads-seen.json) left out, and written to leads.md, page by page, for /refresh-events to judge
//
//   node scripts/leads.mts         crawls, then writes leads.md
//   node scripts/leads.mts --all   the same, with the passages judged before

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { CoursesIndex, type Section, TermFile, activeTerms } from "../src/courses/course.mts"
import { Gazetteer } from "../src/places/gazetteer.mts"
import { placeMatcher } from "../src/social/aliases.mts"
import { Curated, fromCurated } from "../src/social/curated.mts"
import { EventsData } from "../src/social/event.mts"
import { type Lead, Seen, TERM_DAYS, leadsOf, pageExcluded, passagesOf, robotsAllows, whenText } from "../src/social/leads.mts"
import { contentHash } from "../src/shared/hash.mts"
import { plain } from "../src/social/sources.mts"
import { type Day, localDay } from "../src/shared/time.mts"
import { REPO } from "./files.mts"

/** The sections crawled, each a host and the path its pages are under: student life, languages, the library, Campus Rec, the arena, and the offices students drop in on */
const SEEDS = [
  "https://students.unh.edu/",
  "https://cola.unh.edu/languages-literatures-cultures",
  "https://library.unh.edu/",
  "https://campusrec.unh.edu/",
  "https://www.unh.edu/whittemore-center-arena",
  "https://www.unh.edu/global/",
  "https://www.unh.edu/health/",
  "https://www.unh.edu/career/",
  "https://www.unh.edu/student-success/",
  "https://www.unh.edu/pacs/",
  "https://www.unh.edu/sharpp/",
  "https://www.unh.edu/sustainability/",
  "https://www.unh.edu/life-unh"
]

/** Links followed from a seed, and pages read of each section, at most */
const DEPTH = 3
const PAGES = 200

/** Requests at once, and the pause after each */
const AT_ONCE = 2
const PAUSE = 500

/** Who's asking, as the build says it (scripts/map/events.mts) */
const HEADERS = { "user-agent": "notunh/1 (+https://notunh.app)" }

/** Files that aren't pages */
const NOT_HTML = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|mp[34]|zip|ics|xml|json|css|js)$/i

/** Answers that mean a host doesn't want us: a limit, a challenge in place of the page, or a sign-in. A page refused (403) is left alone, its host not */
const LIMITED = [429, 503]
const CHALLENGE = /cf-chl|Just a moment\.\.\./

/** What a host's robots.txt is taken to say when it can't be read for its own fault: nobody may read anything */
const NOBODY = "User-agent: *\nDisallow: /"
const SIGN_IN = /\/(login|signin|saml|shibboleth|idp|cas)\b|login\.|idp\.|sso\./i

const inRepo = (path: string) =>
  fileURLToPath(new URL(path, REPO))

const CACHE = inRepo("node_modules/.cache/notunh-leads/pages.json")
const SEEN = inRepo("leads-seen.json")
const OUT = inRepo("leads.md")

/** A page as the last run read it: what it answered to ask again by, its title, <main>, links, and when it was published */
type Page = { etag?: string, modified?: string, title: string, main: string, links: string[], published?: Day }

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as unknown

const cache = (await readJson(CACHE)) as Record<string, Page>
const today = localDay(Date.now())

//#region Crawling

const robots = new Map<string, Promise<string>>()
const unwelcome = new Set<string>()

/** Whether robots.txt lets anyone read a page */
const mayRead = async (url: URL) => {
  if (!robots.has(url.host))
    robots.set(url.host, fetch(`${url.origin}/robots.txt`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) })
      .then(response => response.ok ? response.text() : response.status >= 500 ? NOBODY : "", () => NOBODY))
  return robotsAllows(await robots.get(url.host)!, url.pathname)
}

/** A page's address as it's kept, without a trailing slash */
const addressOf = ({ origin, pathname }: URL) =>
  `${origin}${pathname.replace(/\/$/, "") || "/"}`

/** A page's links, without fragments, queries, or files */
const linksOf = (html: string, base: URL) =>
  [...new Set([...html.matchAll(/href="([^"#]+)/g)].flatMap(([, href]) => {
    try {
      const url = new URL(href, base)
      return url.protocol === "https:" && !url.search && !NOT_HTML.test(url.pathname) ? [addressOf(url)] : []
    } catch {
      return []
    }
  }))]

/** A page's title, without the site's name after it */
const titleOf = (html: string) =>
  plain(html.match(/<title[^>]*>([^<]*)/)?.[1] ?? "").replace(/\s*\|.*$/, "")

/** When a page was published, as news is dated */
const publishedOf = (html: string) =>
  html.match(/(?:article:published_time" content="|<time datetime=")(\d{4}-\d\d-\d\d)/)?.[1] as Day | undefined

/** A page, asked again only if it changed, or none where it isn't one to read */
const pageOf = async (address: string): Promise<Page | undefined> => {
  const url = new URL(address)
  if (unwelcome.has(url.host) || !await mayRead(url))
    return
  const known = cache[address]
  const response = await fetch(address, {
    headers: { ...HEADERS, ...known?.etag && { "if-none-match": known.etag }, ...known?.modified && { "if-modified-since": known.modified } },
    signal:  AbortSignal.timeout(30_000)
  }).catch(() => undefined)
  await setTimeout(PAUSE)
  if (response?.status === 304 && known)
    return known
  const answered = response && new URL(response.url)
  if (!response || !answered || SIGN_IN.test(answered.host + answered.pathname))
    return
  const html = response.headers.get("content-type")?.includes("text/html") ? await response.text() : ""
  if (LIMITED.includes(response.status) || CHALLENGE.test(html) && !/<main\b/i.test(html)) {
    console.warn(`${url.host} answered ${response.status} to ${address}, so it's left alone`)
    unwelcome.add(url.host)
    return
  }
  if (!response.ok || !html || answered.host !== url.host)
    return
  const etag = response.headers.get("etag")
  const modified = response.headers.get("last-modified")
  const published = publishedOf(html)
  return {
    ...etag && { etag },
    ...modified && { modified },
    title: titleOf(html),
    main:  html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? "",
    links: linksOf(html, answered),
    ...published && { published }
  }
}

/** Every page of the sections, breadth first, each once */
const crawl = async () => {
  const pages = new Map<string, Page>()
  for (const seed of SEEDS) {
    const scope = new URL(seed)
    const base = scope.pathname.replace(/\/$/, "")
    const within = (address: string) => {
      const { host, pathname } = new URL(address)
      return host === scope.host && (pathname === base || pathname.startsWith(`${base}/`))
    }
    let level = [addressOf(scope)]
    const seen = new Set(level)
    let read = 0
    for (let depth = 0; depth <= DEPTH && level.length && read < PAGES; depth++) {
      const next: string[] = []
      const queue = level.filter(address => !pages.has(address)).slice(0, PAGES - read)
      read += queue.length
      await Promise.all(Array.from({ length: AT_ONCE }, async () => {
        for (let address = queue.shift(); address; address = queue.shift()) {
          const page = await pageOf(address)
          if (!page)
            continue
          pages.set(address, page)
          for (const link of page.links)
            if (within(link) && !seen.has(link) && !pageExcluded(link, undefined, today)) {
              seen.add(link)
              next.push(link)
            }
        }
      }))
      level = next
    }
    console.log(`${seed}: ${[...pages.keys()].filter(within).length} pages`)
  }
  return pages
}

//#endregion

const pages = await crawl()
await mkdir(dirname(CACHE), { recursive: true })
await writeFile(CACHE, JSON.stringify(Object.fromEntries(pages)))

// What's known already: the places, the classes of the terms on or coming, the calendars' events, the series kept,
// and the passages judged before
const gazetteer = v.parse(Gazetteer, await readJson(inRepo("src/map/gazetteer.json")))
const match = placeMatcher(gazetteer.places.map(place => place.name))
const index = v.parse(CoursesIndex, await readJson(inRepo("src/courses/courses.json")))
const sections: Section[] = []
for (const term of activeTerms(index.terms, Date.now(), TERM_DAYS))
  sections.push(...v.parse(TermFile, await readJson(inRepo(`public${term.file}`))).sections)
const events = [
  ...v.parse(EventsData, await readJson(inRepo("src/map/events.json"))).events,
  ...fromCurated(v.parse(Curated, await readJson(inRepo("src/social/curated.json"))), today, TERM_DAYS, match)
]
const known = { subjects: new Set(sections.map(({ subject }) => subject)), sections, events }
const seen = v.parse(Seen, await readJson(SEEN))
const all = process.argv.includes("--all")

/** A passage's name in leads-seen.json: the start of its text's SHA-256 */
const hashOf = async (text: string) =>
  (await contentHash(text.replace(/\s+/g, " ").trim())).slice(0, 16)

const found: { url: string, title: string, leads: (Lead & { hash: string })[] }[] = []
const reasons = new Map<string, number>()
const listed = new Set<string>()
let stated = 0
let judged = 0
for (const [url, page] of pages) {
  const excluded = pageExcluded(url, page.published, today)
  if (excluded) {
    reasons.set(excluded, (reasons.get(excluded) ?? 0) + 1)
    continue
  }
  const leads: (Lead & { hash: string })[] = []
  for (const lead of leadsOf(passagesOf(page.main, url), match, known, today)) {
    stated++
    if ("reason" in lead) {
      const reason = lead.reason.replace(/ \(.*\)$/, "")
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      continue
    }
    const hash = await hashOf(lead.text)
    if (hash in seen && !all)
      judged++
    else if (!listed.has(hash)) {
      listed.add(hash)
      leads.push({ ...lead, hash })
    }
  }
  if (leads.length)
    found.push({ url, title: page.title, leads: leads.sort((a, b) => b.score - a.score) })
}
found.sort((a, b) => b.leads[0].score - a.leads[0].score)

const count = found.reduce((sum, { leads }) => sum + leads.length, 0)
const lines = [
  `# Leads, ${today}`,
  "",
  `${pages.size} pages read; ${stated} passages state a time; ${count} leads new or changed, ${judged} judged before. Left out: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${n} ${reason}`).join(", ") || "none"}.`,
  "",
  "Each lead: its score, what it was read as (days, times, place), and its hash, which leads-seen.json keeps its verdict by.",
  ...found.flatMap(({ url, title, leads }) => [
    "",
    `## ${title || url}`,
    "",
    url,
    ...leads.flatMap(lead => [
      "",
      `- **${lead.score}** · ${whenText(lead.when)}${lead.place ? ` · ${lead.place}` : ""} · \`${lead.hash}\`${lead.heading ? ` · under "${lead.heading}"` : ""}`,
      `  > ${lead.text}`
    ])
  ])
]
await writeFile(OUT, lines.join("\n") + "\n")
console.log(`${count} leads on ${found.length} pages in leads.md; ${judged} judged before`)
