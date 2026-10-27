// Reading a program's page in UNH's catalog for its requirements: the CourseLeaf course lists (table.sc_courselist)
// under its Requirements tab, row by row. Each row is a heading (areaheader), a course with its "or" alternatives
// (orclass rows after it), or a note in the catalog's words, with the courses and notes indented under it, or, for a
// note pointing to what follows ("Select one course from the following:") with nothing indented under it, the course
// rows right after it up to the next heading or note, as the catalog lays out its choices either way. Any row that's
// none of these, or courses indented under nothing, or a note pointing to a list with nothing under it at all, makes
// the program's lists unsure, and then it keeps only the courses its requirements name, every one, in order. The
// words of a note are kept as they are and never read for what they mean. The sample degree plan under the Degree
// Plan tab (table.sc_plangrid) is read the same way, term by term, and kept only if every row reads and it names most
// of the lists' courses. Only Durham's programs are read, never Professional Studies', online or in Manchester

import { CATALOG, textOf, yearOf } from "./catalog.mts"
import { type Item, type PlanTerm, type Program, type Row, kindOf } from "./program.mts"
import type { Prereqs } from "./prereqs.mts"
import { withNeeds } from "./graph.mts"

/** A course's code as the lists write it */
const CODE = /\b[A-Z]{2,5} \d{3}[A-Z]{0,2}\b(?!-)/g

/** Every course code in some HTML, in order, repeats left out, its cells kept apart */
const codesIn = (html: string) =>
  [...new Set(textOf(html.replace(/<sup>[\s\S]*?<\/sup>/g, "").replace(/<\/?(?:td|tr|th|p|li|div)\b[^>]*>/g, " ")).match(CODE) ?? [])]

/** A cell's text, its footnote marks left off */
const cellText = (html: string) =>
  textOf(html.replace(/<sup>[\s\S]*?<\/sup>/g, ""))

/** The catalog's address of a program, from its breadcrumb's last link, its department's, and its own name */
const urlOf = (html: string, slug: string) => {
  const crumbs = html.match(/id="breadcrumb"[\s\S]*?<\/nav>|id="breadcrumb"[\s\S]{0,3000}/)?.[0] ?? ""
  const department = [...crumbs.matchAll(/href="(\/undergraduate\/[^"]*\/programs-study\/[^"]*)"/g)].at(-1)?.[1]
  return department ? `${CATALOG}${department}${slug}/` : undefined
}

/** A note pointing to the rows after it, whose choices may be laid out unindented */
const POINTS_ON = /\bfollow|\bbelow\b/i

/** A program page's course lists as rows, or none if any row can't be read for sure */
export const rowsOf = (requirements: string): Row[] | undefined => {
  const tables = [...requirements.matchAll(/<table[^>]*class="sc_courselist"[^>]*>([\s\S]*?)<\/table>/g)]
  if (!tables.length)
    return
  const rows: Row[] = []
  /** The note the indented rows after it are listed under */
  let note: Extract<Row, { note: string }> | undefined
  /** Whether the note's choices are the unindented course rows after it, as none are indented under it */
  let takesUnindented = false
  for (const [, table] of tables)
    for (const [, kind, inner] of table.matchAll(/<tr class="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)) {
      if (/hidden|noscript|listsum/.test(kind))
        continue
      const cells = [...inner.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)]
      const credits = cellText(cells.find(([, attributes]) => attributes.includes("hourscol"))?.[2] ?? "") || undefined
      const code = cells.find(([, attributes]) => attributes.includes("codecol"))?.[2]
      const first = cells[0]?.[2] ?? ""
      const isIndented = /^\s*<div[^>]*class="blockindent"/.test(first)
      if (/areaheader/.test(kind)) {
        note = undefined
        rows.push({ header: cellText(first) })
      }
      else if (/orclass/.test(kind)) {
        const item: Item = codesIn(code ?? "")
        const last = rows.at(-1)
        if (!item.length)
          return
        if (note)
          (note.options ??= []).push(item)
        else if (last && "course" in last)
          last.course.push(item)
        else
          return
      }
      else if (code !== undefined) {
        const item: Item = codesIn(code)
        if (!item.length)
          return
        if (isIndented && note)
          (note.options ??= []).push(item)
        else if (isIndented)
          return
        else if (note && (takesUnindented || (!note.options && POINTS_ON.test(note.note)))) {
          takesUnindented = true
          ;(note.options ??= []).push(item)
        }
        else {
          note = undefined
          rows.push({ course: [item], ...credits && { credits } })
        }
      }
      else if (/courselistcomment/.test(first)) {
        const text = cellText(first)
        if (isIndented && note)
          (note.options ??= []).push(text)
        else if (isIndented)
          return
        else {
          takesUnindented = false
          rows.push(note = { note: text, ...credits && { credits } })
        }
      }
      else
        return
    }
  // A note pointing to a list ("from the following", "below") with nothing under it lists its choices some other
  // way, which can't be told from courses required
  const isUnlisted = rows.some(row => "note" in row && /\bfollow|\bbelow\b|\blist\b/i.test(row.note) && !row.options?.length)
  return isUnlisted ? undefined : rows
}

/** A page's sample degree plan as its terms, or none if there isn't exactly one grid or any row can't be read for sure */
export const planOf = (html: string): PlanTerm[] | undefined => {
  const start = html.indexOf('id="degreeplantextcontainer"')
  if (start < 0)
    return
  const end = html.indexOf('class="page_content tab_content"', start + 40)
  const grids = [...html.slice(start, end < 0 ? undefined : end).matchAll(/<table[^>]*class="sc_plangrid"[^>]*>([\s\S]*?)<\/table>/g)]
  if (grids.length !== 1)
    return
  const terms: PlanTerm[] = []
  let year: string | undefined
  for (const [, kind, inner] of grids[0][1].matchAll(/<tr class="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (/hidden|noscript|plangridsum|plangridtotal/.test(kind))
      continue
    const heading = textOf(inner.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? "")
    if (/plangridyear/.test(kind))
      year = heading
    else if (/plangridterm/.test(kind) && year)
      terms.push({ year, term: heading, courses: [] })
    else {
      const code = [...inner.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].find(([, attributes]) => attributes.includes("codecol"))?.[2]
      const term = terms.at(-1)
      if (code === undefined || !term)
        return
      // A row of a course, with its alternatives, or a comment in the plan's words, "Discovery I", which isn't a course
      const codes = codesIn(code)
      if (!codes.length && !/class="comment"/.test(code))
        return
      term.courses.push(...codes.filter(code => !term.courses.includes(code)))
    }
  }
  return terms.length >= 2 ? terms : undefined
}

/**
 * A program's page read: its title, address, kind, the catalog's year, its rows if they read for sure, its plan if it
 * reads for sure and names most of the courses the rows list on rows of their own (an option's page may carry its
 * major's plan), the courses named, and the titles its own lists give them; or none if it isn't a Durham program's
 */
export const programOf = (html: string, slug: string): Program | undefined => {
  const url = urlOf(html, slug)
  const start = html.indexOf('id="requirementstextcontainer"')
  if (!url || url.includes("/professional-studies/") || start < 0)
    return
  const end = html.indexOf('class="page_content tab_content"', start + 40)
  const requirements = html.slice(start, end < 0 ? undefined : end)
  const title = textOf(html.match(/<h1 class="page-title">([\s\S]*?)<\/h1>/)?.[1] ?? slug)
  const rows = rowsOf(requirements)
  const plan = planOf(html)
  const listed = rows?.flatMap(row => "course" in row ? row.course[0] : []) ?? []
  const planned = new Set(plan?.flatMap(term => term.courses))
  const isPlanned = plan && rows && listed.filter(code => planned.has(code)).length * 2 >= listed.length
  // Every course a table names, or failing tables, the requirements' text
  const tables = [...requirements.matchAll(/<table[^>]*class="sc_courselist"[^>]*>[\s\S]*?<\/table>/g)].map(([table]) => table).join("")
  const courses = codesIn(tables || requirements)
  // The title each list gives a course, for a course the catalog's descriptions have none of
  const titles: Record<string, string> = {}
  for (const [, row] of tables.matchAll(/<tr class="(?![^"]*areaheader)[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const [codes = "", names = ""] = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell)
    // Courses taken together are a line each, "CS 791" over "& CS 792", as are their titles, "and Senior Project II"
    const [lines, named] = [codes, names].map(cell => cell.split(/<br\s*\/?>/))
    if (lines.length === named.length)
      lines.forEach((line, i) => {
        const [code] = codesIn(line)
        const title = cellText(named[i]).replace(/^and /, "")
        if (code && title)
          titles[code] = title
      })
  }
  return {
    slug,
    title,
    kind: kindOf(title),
    url,
    year: yearOf(html),
    ...rows && { rows },
    ...isPlanned && { plan },
    courses,
    titles
  }
}

/**
 * Programs with their titles filled: of each course named and each it needs, however far back, the catalog's
 * description's title, else the title its program's list gives it
 */
export const withTitles = (pages: readonly Program[], prereqs: Prereqs, titles: ReadonlyMap<string, string>): Program[] =>
  pages.map(page => {
    const named = withNeeds(page.courses, code => prereqs.courses[code]?.needs)
    const found = named.flatMap(code => {
      const title = titles.get(code) ?? page.titles[code]
      return title ? [[code, title] as const] : []
    })
    return { ...page, titles: Object.fromEntries(found) }
  })
