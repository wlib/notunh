// Durham's programs of study, majors, minors, options and cognates, as the catalog lists their requirements, for the
// view of a program's courses by what each needs (src/map/ui/Program.tsx). Each program is a file of its own, named by
// its contents under /data/programs/, loaded only once it's opened, and a list of them all, which the prerequisites'
// index names (prereqs.mts), loaded once a program or a course's line to its programs is wanted.
//
// A program's rows are the catalog's course lists as they're laid out: headings, courses with their "or"
// alternatives, and notes in the catalog's own words, like "Select one course from the following:", with the courses
// listed under them. Nothing here says what a note means, how many to pick, or whether a requirement is met: that's
// the catalog's to say, which every view links to. A program whose lists can't be read for sure has no rows, only the
// courses its requirements name, which a view lists rather than lay out. A program with a sample degree plan that
// reads for sure has its terms too, each with the courses the plan puts in it, for the view by term

import * as v from "valibot"
import { objectOf } from "../shared/json.mts"

/** Courses taken together, one or more, as the catalog's "CS 791 & CS 792" */
export type Item = string[]

/** A row of a program's course lists: a heading, a course and its alternatives, or a note and what's listed under it */
export type Row =
  | { header: string }
  | { course: Item[], credits?: string }
  | { note: string, credits?: string, options?: (Item | string)[] }

/** A term of the catalog's sample degree plan: its year and term as the plan words them, and the courses it puts there */
export type PlanTerm = { year: string, term: string, courses: string[] }

/** What kind of program, from its title */
export type Kind = "major" | "option" | "minor" | "cognate" | "program"

/** A program's file */
export type Program = {
  slug:    string,
  title:   string,
  kind:    Kind,
  /** Its page in the catalog, which says what its requirements are */
  url:     string,
  /** The catalog's year, like "2026-2027" */
  year:    string,
  /** Its course lists as rows, or none where they couldn't be read for sure */
  rows?:   Row[],
  /** Its sample degree plan's terms in order, or none where there's no plan or it couldn't be read for sure */
  plan?:   PlanTerm[],
  /** Every course its requirements name, in the order named */
  courses: string[],
  /** The title of each course named, and of each course those need, by code */
  titles:  Record<string, string>
}

/** A program's file, taken on trust past its shape, as it's ours */
export const Program = objectOf<Program>()

/** A program as the list of them names it, with its file */
export type Listed = { slug: string, title: string, kind: Kind, file: string }

/** Every program, and by each course's code, those naming it, as indices into the programs */
export type Programs = { fetched: number, programs: Listed[], courses: Record<string, number[]> }

export const Programs = v.object({
  fetched:  v.number(),
  programs: v.array(v.object({ slug: v.string(), title: v.string(), kind: v.picklist(["major", "option", "minor", "cognate", "program"]), file: v.string() })),
  courses:  objectOf<Record<string, number[]>>()
})

/** What kind of program a title says it is: "Computer Science Major: Artificial Intelligence Option (B.A.)" an option */
export const kindOf = (title: string): Kind =>
  /\bOption\b/i.test(title)  ? "option" :
  /\bMinor\b/i.test(title)   ? "minor" :
  /\bCognate\b/i.test(title) ? "cognate" :
  /\bMajor\b|\(B\.[A-Z.]+\)/.test(title) ? "major" :
                               "program"

/** How each course a program names is listed: on a row of its own, as an alternative on one, or among a note's */
export type Role = "listed" | "or" | "option"

/** Each course a program's rows name, by the firmest way it's listed: on a row of its own before as an alternative, before among a note's */
export const rolesOf = (program: Pick<Program, "rows" | "courses">) => {
  const roles = new Map<string, Role>()
  const set = (codes: Item, role: Role) => {
    for (const code of codes)
      if (!roles.has(code))
        roles.set(code, role)
  }
  const rows = program.rows ?? []
  for (const row of rows)
    if ("course" in row)
      set(row.course[0], "listed")
  for (const row of rows)
    if ("course" in row)
      row.course.slice(1).forEach(item => set(item, "or"))
  for (const row of rows)
    if ("note" in row)
      for (const option of row.options ?? [])
        if (typeof option !== "string")
          set(option, "option")
  for (const code of program.courses)
    set([code], "listed")
  return roles
}

/** Where a course is listed in a program: the heading it's under, and the note it's among, as the catalog words them */
export const listedUnder = (program: Pick<Program, "rows">, code: string) => {
  let header: string | undefined
  for (const row of program.rows ?? []) {
    if ("header" in row)
      header = row.header
    else if ("course" in row && row.course.some(item => item.includes(code)))
      return { header }
    else if ("note" in row && row.options?.some(option => typeof option !== "string" && option.includes(code)))
      return { header, note: row.note }
  }
}
