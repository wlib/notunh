import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { CATALOG, isAllowed, programUrlsOf, SITEMAP } from "../../src/programs/catalog.mts"
import { type Item, type Row, kindOf, listedUnder, rolesOf } from "../../src/programs/program.mts"
import { planOf, programOf, rowsOf } from "../../src/programs/requirements.mts"
import { publishPrereqs, readPrograms } from "../../scripts/programs/prereqs.mts"

// Program pages trimmed to their breadcrumb, title and requirements
const FIXTURES = new URL("../fixtures/programs/programs/", import.meta.url)
const page = (slug: string) => readFile(new URL(`${slug}.html`, FIXTURES), "utf8")

test("the CS major's lists read as the catalog lays them out", async () => {
  const program = programOf(await page("computer-science-major-bs"), "computer-science-major-bs")!
  expect(program).toMatchObject({
    title: "Computer Science Major (B.S.)",
    kind:  "major",
    url:   `${CATALOG}/undergraduate/engineering-physical-sciences/programs-study/computer-science/computer-science-major-bs/`,
    year:  "2026-2027"
  })
  const rows = program.rows!
  expect(rows[0]).toEqual({ header: "Computer Science Courses" })
  expect(rows).toContainEqual({ course: [["CS 415"], ["CS 410C"], ["CS 410P"]], credits: "4" })
  // The senior project's two halves together, or the thesis
  expect(rows).toContainEqual({ course: [["CS 791", "CS 792"], ["CS 799"]], credits: "4" })
  const electives = rows.find(row => "note" in row && row.note === "Select one course from the following:")
  expect(electives).toMatchObject({ credits: "3-4" })
  expect((electives as Extract<Row, { note: string }>).options).toContain("CS 700-level course")
  expect(listedUnder(program, "MATH 525")).toEqual({ header: "Professional Electives", note: "Select one course from the following:" })
  expect(rolesOf(program).get("CS 415")).toBe("listed")
  expect(rolesOf(program).get("CS 410C")).toBe("or")
  expect(rolesOf(program).get("MATH 525")).toBe("option")
  expect(program.titles["CS 791"]).toBe("Senior Project I")
})

test("a note pointing to what follows takes the course rows after it, unindented, up to the next heading or note", async () => {
  const program = programOf(await page("mechanical-engineering-major-bs"), "mechanical-engineering-major-bs")!
  const rows = program.rows!
  expect(rows).toContainEqual({ course: [["ME 755"], ["TECH 797"]], credits: "2" })
  const pools = rows.filter((row): row is Extract<Row, { note: string }> => "note" in row && (row.options?.length ?? 0) > 0)
  expect(pools.map(pool => pool.options)).toEqual([
    [["ME 707"], ["ME 712"], ["ME 727"]],
    [["ME 709"], ["ME 710"], ["ME 772"], ["ME 786"]],
    [["CS 410C"], ["CS 410P"], ["ESCI 501"], ["ECE 543"], ["TECH 750"], ["TECH 780"]]
  ])
  expect(pools[0].note).toBe("Select one course from the following:")
  // The catalog's "Approved Analytical Technical Electives" is a note of its own before the list, not a heading
  expect(listedUnder(program, "ME 712")).toEqual({ header: "Required Courses", note: "Select one course from the following:" })
  expect(rolesOf(program).get("ME 712")).toBe("option")
})

test("the sample degree plan reads term by term, and is kept when it names most of the courses listed", async () => {
  const cs = programOf(await page("computer-science-major-bs"), "computer-science-major-bs")!
  expect(cs.plan!.map(term => `${term.year} ${term.term}`)).toEqual(["First Year Fall", "First Year Spring", "Second Year Fall", "Second Year Spring", "Third Year Fall", "Third Year Spring", "Fourth Year Fall", "Fourth Year Spring"])
  expect(cs.plan![0].courses).toEqual(["CS 400", "CS 415", "IT 403", "MATH 425"])
  // A slot with alternatives names them all; a comment like "Discovery I" names no course
  expect(cs.plan![2].courses).toContain("MATH 539")
  expect(programOf(await page("computer-science-minor"), "computer-science-minor")!.plan).toBeUndefined()
  const grid = (rows: string) => `<div id="degreeplantextcontainer"><table class="sc_plangrid">${rows}</table></div>`
  const year = `<tr class="plangridyear"><th class="year" colspan="3">First Year</th></tr>`
  const term = (name: string) => `<tr class="plangridterm"><th colspan="2">${name}</th><th class="hourscol">Credits</th></tr>`
  const course = (code: string) => `<tr class="even"><td class="codecol"><a href="/search/?P=${encodeURIComponent(code)}">${code}</a></td><td class="titlecol">A title</td><td class="hourscol">4</td></tr>`
  const comment = `<tr class="odd"><td colspan="2" class="codecol"><span class="comment">Discovery I</span></td><td class="hourscol">4</td></tr>`
  const sum = `<tr class="plangridsum odd"><td> </td><td class="titlecol">Credits</td><td class="hourscol">8</td></tr>`
  expect(planOf(grid(year + term("Fall") + course("CS 415") + comment + sum + term("Spring") + course("CS 416")))).toEqual([
    { year: "First Year", term: "Fall", courses: ["CS 415"] },
    { year: "First Year", term: "Spring", courses: ["CS 416"] }
  ])
  // One term is no plan, a course before any term can't be placed, and two grids can't be told apart
  expect(planOf(grid(year + term("Fall") + course("CS 415")))).toBeUndefined()
  expect(planOf(grid(year + course("CS 415") + term("Fall")))).toBeUndefined()
  expect(planOf(grid(year + term("Fall") + course("CS 415") + term("Spring")) + grid(year + term("Fall") + course("CS 415") + term("Spring")))).toBeUndefined()
})

test("a program whose lists can't be read for sure keeps every course they name, and no rows", async () => {
  const program = programOf(await page("political-science-major-ba"), "political-science-major-ba")!
  expect(program.rows).toBeUndefined()
  expect(program.courses).toContain("POLT 500")
  expect(program.courses.length).toBeGreaterThan(40)
})

test("Professional Studies' programs, online or in Manchester, are never read", async () => {
  expect(programOf(await page("accounting-finance-major-bs"), "accounting-finance-major-bs")).toBeUndefined()
  expect(isAllowed(`${CATALOG}/undergraduate/professional-studies/online/programs-study/business/accounting-finance-major-bs/`)).toBe(false)
  expect(isAllowed(`${CATALOG}/undergraduate/engineering-physical-sciences/programs-study/computer-science/computer-science-minor/`)).toBe(true)
  expect(isAllowed(SITEMAP)).toBe(true)
  const sitemap = [
    `${CATALOG}/undergraduate/engineering-physical-sciences/programs-study/computer-science/computer-science-minor/`,
    `${CATALOG}/undergraduate/engineering-physical-sciences/programs-study/`,
    `${CATALOG}/undergraduate/professional-studies/online/programs-study/business/accounting-finance-major-bs/`,
    `${CATALOG}/graduate/programs-study/analytics/data-science-certificate/`
  ].map(url => `<url><loc>${url}</loc></url>`).join("")
  expect(programUrlsOf(sitemap)).toEqual([`${CATALOG}/undergraduate/engineering-physical-sciences/programs-study/computer-science/computer-science-minor/`])
})

test("a program's kind is read from its title", () => {
  expect(kindOf("Computer Science Major: Artificial Intelligence Option (B.A.)")).toBe("option")
  expect(kindOf("Computer Science Minor")).toBe("minor")
  expect(kindOf("Medical Sociology Cognate")).toBe("cognate")
  expect(kindOf("Nursing Major (B.S.N.)")).toBe("major")
  expect(kindOf("Veterinary Technology (A.A.S.)")).toBe("program")
})

// Rows drawn as CourseLeaf draws them, to read back
const codeCell = (item: Item, indent: boolean) => {
  const [first, ...rest] = item.map(code => `<a href="/search/?P=${encodeURIComponent(code)}" class="bubblelink code">${code}</a>`)
  const inner = first + rest.map(code => `<br/><span style="margin-left:20px;" class="blockindent">&amp; ${code}</span>`).join("")
  return `<td class="codecol">${indent ? `<div style="margin-left:20px;" class="blockindent">${inner}</div>` : inner}</td>`
}
const htmlOf = (rows: Row[]) =>
  `<table class="sc_courselist"><tbody>${rows.map(row => {
    if ("header" in row)
      return `<tr class="even areaheader"><td colspan="2"><span class="courselistcomment areaheader ">${row.header}</span></td><td class="hourscol"></td></tr>`
    if ("course" in row)
      return [
        `<tr class="odd">${codeCell(row.course[0], false)}<td>A title</td><td class="hourscol">${row.credits ?? ""}</td></tr>`,
        ...row.course.slice(1).map(item => `<tr class="orclass odd"><td class="codecol orclass">or ${codeCell(item, false).slice('<td class="codecol">'.length)}<td colspan="2">Another</td></tr>`)
      ].join("")
    return [
      `<tr class="even"><td colspan="2"><span class="courselistcomment">${row.note}</span></td><td class="hourscol">${row.credits ?? ""}</td></tr>`,
      ...(row.options ?? []).map(option => typeof option === "string"
        ? `<tr class="even"><td colspan="2"><div style="margin-left:20px;" class="blockindent"><span class="courselistcomment commentindent">${option}</span></div></td><td class="hourscol"></td></tr>`
        : `<tr class="odd">${codeCell(option, true)}<td>A title</td><td class="hourscol"></td></tr>`)
    ].join("")
  }).join("")}</tbody></table>`

const item = fc.uniqueArray(fc.tuple(fc.constantFrom("CS", "MATH", "IT"), fc.integer({ min: 400, max: 799 })).map(([subject, n]) => `${subject} ${n}`), { minLength: 1, maxLength: 2 })
const words = fc.constantFrom("Electives", "Capstone", "Select two courses:", "Select one of the following:", "An approved 700-level course", "Required Courses")
const POINTS_ON = /\bfollow|\bbelow\b/i
const credits = fc.option(fc.constantFrom("4", "8", "3-4"), { nil: undefined })
const row: fc.Arbitrary<Row> = fc.oneof(
  words.map(header => ({ header })),
  fc.record({ course: fc.array(item, { minLength: 1, maxLength: 3 }), credits }).map(({ course, credits }) => ({ course, ...credits && { credits } })),
  fc.record({ note: words, credits, options: fc.option(fc.array(fc.oneof(item, words), { minLength: 1, maxLength: 4 }), { nil: undefined }) })
    .map(({ note, credits, options }) => ({ note, ...credits && { credits }, ...options && { options } }))
)

test("rows read back from the catalog's markup as they were laid out", () => {
  fc.assert(fc.property(fc.array(row, { maxLength: 12 }), rows => {
    // A note's options only follow it; a course row after them ends them, as the catalog's do. A note pointing to
    // what follows with nothing under it is read otherwise: as unsure, or as taking the courses after it
    fc.pre(rows.every(row => !("note" in row) || row.options?.length || !POINTS_ON.test(row.note)))
    expect(rowsOf(htmlOf(rows))).toEqual(rows)
  }))
})

test("courses indented under nothing, or a note pointing to a list with nothing under it, make a program's rows unsure", () => {
  const indented = `<table class="sc_courselist"><tbody><tr class="odd">${codeCell(["CS 415"], true)}<td>A</td><td class="hourscol"></td></tr></tbody></table>`
  expect(rowsOf(indented)).toBeUndefined()
  expect(rowsOf(htmlOf([{ note: "Select one course from the following:" }]))).toBeUndefined()
  expect(rowsOf(htmlOf([{ note: "Select one course from the list" }, { course: [["CS 415"]] }]))).toBeUndefined()
  expect(rowsOf(htmlOf([{ note: "Select one course from the following:", options: [["CS 415"]] }]))).toBeDefined()
  expect(rowsOf(htmlOf([{ note: "Select one of the following approved minors:", options: ["Statistics Minor"] }]))).toBeDefined()
  expect(rowsOf("<p>No tables, only prose</p>")).toBeUndefined()
})

test("a note pointing to what follows takes the unindented course rows after it, to the next heading or note, and only if there are any", () => {
  const taken = rowsOf(htmlOf([{ note: "Select one course from the following:" }, { course: [["CS 415"]], credits: "4" }, { course: [["CS 416"], ["CS 417"]], credits: "4" }, { header: "Mathematics" }, { course: [["MATH 425"]], credits: "4" }]))
  expect(taken).toEqual([{ note: "Select one course from the following:", options: [["CS 415"], ["CS 416"], ["CS 417"]] }, { header: "Mathematics" }, { course: [["MATH 425"]], credits: "4" }])
  // Once a note has courses indented under it, an unindented course after them is a course of its own
  expect(rowsOf(htmlOf([{ note: "Select one course from the following:", options: [["CS 415"]] }, { course: [["CS 416"]] }]))).toEqual([{ note: "Select one course from the following:", options: [["CS 415"]] }, { course: [["CS 416"]] }])
})

test("the list of programs names each program's file, and every course's programs are those naming it", async () => {
  const programs = await readPrograms(fileURLToPath(FIXTURES))
  expect(programs.map(program => program.slug).sort()).toEqual((await readdir(FIXTURES)).map(name => name.slice(0, -5)).filter(slug => !slug.startsWith("accounting")).sort())
  const { files, index } = await publishPrereqs({ fetched: 0, courses: {} }, programs)
  const list = JSON.parse(files.get(index.programs!)!)
  expect(new Set(index.files)).toEqual(new Set(files.keys()))
  for (const [i, program] of programs.entries()) {
    expect(JSON.parse(files.get(list.programs[i].file)!)).toEqual(program)
    for (const code of program.courses)
      expect(list.courses[code]).toContain(i)
  }
  for (const [code, indices] of Object.entries<number[]>(list.courses))
    for (const i of indices)
      expect(programs[i].courses).toContain(code)
})
