import { test, expect } from "vitest"
import fc from "fast-check"
import { type Graph, byTerm, chainOf, graphOf, isPool, neededIn, poolsOf, withNeeds } from "../../src/programs/graph.mts"
import type { PlanTerm, Row } from "../../src/programs/program.mts"
import type { Req } from "../../src/programs/req.mts"

// Courses from a small pool, so trees name each other often, loops included
const CODES = Array.from({ length: 12 }, (_, i) => `TEST ${400 + i}`)
const code = fc.constantFrom(...CODES)

const req: fc.Arbitrary<Req> = fc.letrec<{ req: Req }>(tie => ({
  req: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    code.map(course => ({ course })),
    fc.constant({ text: "Permission of instructor" }),
    fc.array(tie("req"), { minLength: 2, maxLength: 3 }).map(all => ({ all })),
    fc.array(tie("req"), { minLength: 2, maxLength: 3 }).map(any => ({ any }))
  )
})).req

/** A program's rows: headings, courses with alternatives, and notes with courses and notes under them, or none */
const rows: fc.Arbitrary<Row[]> = fc.array(fc.oneof(
  fc.constantFrom("Required", "Electives").map(header => ({ header })),
  fc.array(fc.uniqueArray(code, { minLength: 1, maxLength: 2 }), { minLength: 1, maxLength: 2 }).map(course => ({ course })),
  fc.record({ note: fc.constantFrom("Select one of the following:", "Select two:"), options: fc.array(fc.oneof(fc.uniqueArray(code, { minLength: 1, maxLength: 2 }), fc.constant("A 700-level course")), { maxLength: 5 }) })
), { maxLength: 8 })

/** The courses a program's rows name, in order, as its file has them */
const coursesOf = (rows: Row[]) =>
  [...new Set(rows.flatMap(row => "course" in row ? row.course.flat() : "note" in row ? (row.options ?? []).flatMap(option => typeof option === "string" ? [] : option) : []))]

/** Some courses' needs, by code, and a program's rows and courses, with a plan over some of its courses */
const catalog = fc.record({
  needs: fc.dictionary(code, req, { maxKeys: CODES.length }),
  rows,
  shuffled: fc.shuffledSubarray(CODES),
  cuts: fc.array(fc.nat(CODES.length), { minLength: 1, maxLength: 4 })
}).map(({ needs, rows, shuffled, cuts }) => {
  const courses = coursesOf(rows)
  // The plan's terms, each the next cut of the shuffled codes, some repeated and some the program never names
  const plan: PlanTerm[] = []
  let at = 0
  for (const [i, cut] of cuts.entries()) {
    plan.push({ year: `Year ${Math.floor(i / 2) + 1}`, term: i % 2 ? "Spring" : "Fall", courses: shuffled.slice(at, at + cut) })
    at += cut
  }
  return { needs, program: { rows, courses, plan } }
})

const laneOf = (graph: Graph) =>
  new Map(graph.lanes.flatMap(({ nodes }, lane) => nodes.map(id => [id, lane] as const)))

const nodesOf = (graph: Graph) =>
  graph.lanes.flatMap(lane => lane.nodes)

test("every course listed is a node or in exactly one pool, and nothing is both", () => {
  fc.assert(fc.property(catalog, ({ needs, program }) => {
    const graph = graphOf(program, code => needs[code])
    const nodes = nodesOf(graph)
    expect(new Set(nodes).size).toBe(nodes.length)
    const members = graph.pools.flatMap(pool => pool.members)
    expect(new Set(members).size).toBe(members.length)
    for (const code of program.courses)
      expect(Number(nodes.includes(code)) + Number(members.includes(code))).toBe(1)
    // The core is every course on a row of its own or as its alternative; the pools hold the rest
    for (const row of program.rows)
      if ("course" in row)
        for (const code of row.course.flat())
          expect(nodes).toContain(code)
    for (const pool of graph.pools)
      expect(nodes).toContain(pool.id)
    expect(graph.pools).toEqual(poolsOf(program))
  }))
})

test("every edge drawn points to a later level, so the edges have no loop", () => {
  fc.assert(fc.property(catalog, ({ needs, program }) => {
    const graph = graphOf(program, code => needs[code])
    const lane = laneOf(graph)
    for (const { from, to } of graph.edges)
      if (lane.has(from) && lane.has(to))
        expect(lane.get(from)!).toBeLessThan(lane.get(to)!)
    // A node on level n > 0 is there for an edge from level n - 1
    for (const [id, n] of lane)
      if (n > 0)
        expect(graph.edges.some(edge => edge.to === id && lane.get(edge.from) === n - 1)).toBe(true)
  }))
})

test("the nodes are the core, what it needs, and the pools, and each edge is a need, a member's into its pool", () => {
  fc.assert(fc.property(catalog, ({ needs, program }) => {
    const graph = graphOf(program, code => needs[code])
    const pools = new Map(graph.pools.flatMap(pool => pool.members.map(code => [code, pool.id] as const)))
    const core = program.courses.filter(code => !pools.has(code))
    const courses = nodesOf(graph).filter(id => !isPool(id))
    const closed = new Set(withNeeds(core, code => needs[code]))
    for (const code of courses)
      expect(closed.has(code)).toBe(true)
    for (const code of core)
      expect(courses).toContain(code)
    const isNamed = (code: string) => program.courses.includes(code)
    for (const { from, to } of graph.edges) {
      if (isPool(from))
        expect(graph.pools.find(pool => pool.id === from)!.members.some(member => neededIn(needs[to], isNamed).includes(member))).toBe(true)
      else if (isPool(to))
        expect(graph.pools.find(pool => pool.id === to)!.members.some(member => needs[member] && neededIn(needs[member], isNamed).includes(from))).toBe(true)
      else
        expect(neededIn(needs[to], isNamed)).toContain(from)
    }
  }))
})

test("by term, the lanes are the plan's terms in order, then what the plan leaves out, and each node is in one lane once", () => {
  fc.assert(fc.property(catalog, ({ needs, program }) => {
    const graph = graphOf(program, code => needs[code])
    const terms = byTerm(graph, program)
    expect(terms.pools).toBe(graph.pools)
    expect(terms.edges).toBe(graph.edges)
    const all = nodesOf(terms)
    expect(all.sort()).toEqual(nodesOf(graph).sort())
    const labels = terms.lanes.map(lane => lane.label)
    const planned = program.plan.map(term => `${term.year} · ${term.term}`)
    const ofPlan = labels.filter(label => label !== "Not in the plan")
    // The plan's terms, in its order, those with a node in them
    expect(ofPlan).toEqual(planned.filter(label => ofPlan.includes(label)))
    if (labels.includes("Not in the plan"))
      expect(labels.at(-1)).toBe("Not in the plan")
    // A course the plan names is in the first term naming it, and the pools are never in a term
    for (const lane of terms.lanes.slice(0, ofPlan.length))
      for (const id of lane.nodes) {
        expect(isPool(id)).toBe(false)
        const first = program.plan.find(term => term.courses.includes(id))
        if (first)
          expect(lane.label).toBe(`${first.year} · ${first.term}`)
      }
  }))
})

test("a focused chain is closed under needs, and its unlocks under unlocking", () => {
  fc.assert(fc.property(catalog, fc.nat(), ({ needs, program }, pick) => {
    const graph = graphOf(program, code => needs[code])
    const drawn = nodesOf(graph)
    const focus = drawn[pick % drawn.length]
    const chain = chainOf(graph, focus)
    expect(chain.needs.has(focus)).toBe(true)
    expect(chain.unlocks.has(focus)).toBe(false)
    for (const { from, to } of graph.edges) {
      if (chain.needs.has(to))
        expect(chain.needs.has(from)).toBe(true)
      if (chain.unlocks.has(from) || from === focus)
        expect(chain.unlocks.has(to)).toBe(true)
    }
  }))
})

test("of alternatives, only those the program names are drawn where it names any", () => {
  const needs: Record<string, Req> = { "CS 518": { any: [{ course: "CS 416" }, { course: "CS 417" }] } }
  const named = (courses: string[]) => ({ courses, rows: courses.map(code => ({ course: [[code]] })) })
  expect(graphOf(named(["CS 518", "CS 416"]), code => needs[code]).edges).toEqual([{ from: "CS 416", to: "CS 518", isAlternative: true }])
  expect(graphOf(named(["CS 518"]), code => needs[code]).lanes).toEqual([{ nodes: ["CS 416", "CS 417"] }, { nodes: ["CS 518"] }])
})

test("a pool sits past what its members need, with an edge from each, and a member's own edges are kept for when it's open", () => {
  const needs: Record<string, Req> = { "CS 712": { course: "CS 515" }, "CS 720": { course: "CS 520" }, "CS 520": { course: "CS 515" } }
  const program = {
    courses: ["CS 515", "CS 520", "CS 712", "CS 720"],
    rows: [{ header: "Courses" }, { course: [["CS 515"]] }, { course: [["CS 520"]] }, { note: "Implementation electives" }, { note: "Select one course from the following:", credits: "4", options: [["CS 712"], ["CS 720"], "CS 700-level course"] }] as Row[]
  }
  const graph = graphOf(program, code => needs[code])
  expect(graph.pools).toEqual([{ id: "pool-1", note: "Select one course from the following:", header: "Courses", lead: "Implementation electives", credits: "4", members: ["CS 712", "CS 720"], texts: ["CS 700-level course"] }])
  expect(graph.lanes).toEqual([{ nodes: ["CS 515"] }, { nodes: ["CS 520"] }, { nodes: ["pool-1"] }])
  expect(graph.edges).toContainEqual({ from: "CS 515", to: "pool-1", isAlternative: true })
  expect(graph.edges).toContainEqual({ from: "CS 520", to: "pool-1", isAlternative: true })
  expect(graph.edges).toContainEqual({ from: "CS 515", to: "CS 712", isAlternative: false })
  expect(chainOf(graph, "CS 515").unlocks).toEqual(new Set(["CS 520", "pool-1", "CS 712", "CS 720"]))
})

test("a loop of needs loses one edge, and both courses are still drawn", () => {
  const needs: Record<string, Req> = { "A 100": { course: "B 100", concurrent: true }, "B 100": { course: "A 100", concurrent: true } }
  const graph = graphOf({ courses: ["A 100", "B 100"], rows: [{ course: [["A 100"]] }, { course: [["B 100"]] }] }, code => needs[code])
  expect(graph.lanes).toEqual([{ nodes: ["B 100"] }, { nodes: ["A 100"] }])
  expect(graph.edges).toEqual([{ from: "B 100", to: "A 100", isAlternative: false }])
})

test("by term, an alternative goes with the course the plan names in its place", () => {
  const program = {
    courses: ["MATH 425", "MATH 425H", "CS 400"],
    rows: [{ course: [["MATH 425"], ["MATH 425H"]] }, { course: [["CS 400"]] }] as Row[],
    plan: [{ year: "First Year", term: "Fall", courses: ["MATH 425"] }, { year: "First Year", term: "Spring", courses: ["ENGL 401"] }]
  }
  const terms = byTerm(graphOf(program, () => undefined), program)
  expect(terms.lanes).toEqual([{ label: "First Year · Fall", nodes: ["MATH 425", "MATH 425H"] }, { label: "Not in the plan", nodes: ["CS 400"] }])
})
