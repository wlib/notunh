// A program's courses laid out by what each needs (program.mts, prereqs.mts): its core, the courses its lists put on
// rows of their own or as their alternatives; every course those need before them, however far back, drawn faint;
// and its pools, the courses listed as choices under one note, each pool folded into one node that opens to its
// members. A node sits on the level one past the furthest of what it needs, so every prerequisite sits on an earlier
// level than the course needing it, a pool one past the furthest of what any member needs. A program with a sample
// degree plan lays the same nodes out by its terms instead (byTerm). One shape for every width and either layout: a
// phone reads the lanes top to bottom, a wide screen left to right (src/map/ui/Program.tsx).
//
// A course needed as one of several alternatives is an edge the view draws dashed, and of alternatives only those
// the program names are drawn where it names any. What a pool's members need is drawn into the pool, and into each
// member when the pool's open; what they need outside the graph is folded, and their pages say it. The catalog has a
// few courses needing each other, as "or concurrently" can make them; the edge closing such a loop is left out, so
// the levels always exist, and the course page still says what each needs in full

import type { Req } from "./req.mts"
import { byCode } from "./catalog.mts"
import { type Program, type Row, rolesOf } from "./program.mts"

/** A prerequisite: `from` is among what `to` needs, as one of several alternatives if `isAlternative` */
export type Edge = { from: string, to: string, isAlternative: boolean }

/**
 * Courses listed as choices under one note, folded into one node: the note's words, the heading it's under, the note
 * right before it with nothing under it where there is one, as the catalog's own sub-heading ("Approved Analytical
 * Technical Electives" before "Select one course from the following:"), its credits as the catalog writes them, the
 * courses under it that aren't the program's core, and the notes under it
 */
export type Pool = { id: string, note: string, header?: string, lead?: string, credits?: string, members: string[], texts: string[] }

/** A row of nodes, courses and pools by id: a level, or a term of the plan, named */
export type Lane = { label?: string, nodes: string[] }

/** The nodes by lane, each lane's in the order drawn, the pools, and the edges between courses and into pools */
export type Graph = { lanes: Lane[], pools: Pool[], edges: Edge[] }

/** Whether a course is named under an "any" in a tree, so it's one alternative among others */
const isAlternativeIn = (req: Req, code: string, isUnderAny = false): boolean =>
  "course" in req ? isUnderAny && req.course === code :
  "text" in req   ? false :
  "all" in req    ? req.all.some(item => isAlternativeIn(item, code, isUnderAny)) :
                    req.any.some(item => isAlternativeIn(item, code, true))

/**
 * What a course needs, as far as a program's graph draws it: every course its tree names, except that of
 * alternatives, only those the program names where it names any, as "MATH 539 or one of seven others" is drawn as
 * MATH 539 alone in a program listing it
 */
export const neededIn = (req: Req, isNamed: (code: string) => boolean): string[] => {
  if ("course" in req)
    return [req.course]
  if ("text" in req)
    return []
  if ("all" in req)
    return req.all.flatMap(item => neededIn(item, isNamed))
  const all = req.any.map(item => neededIn(item, isNamed))
  const named = all.filter(codes => codes.length && codes.every(isNamed))
  return (named.length ? named : all).flat()
}

/** The courses named, and every course they need, however far back, in the order reached */
export const withNeeds = (named: readonly string[], needsOf: (code: string) => Req | undefined) => {
  const isNamed = (code: string) => named.includes(code)
  const all = new Set(named)
  for (const code of all) {
    const needs = needsOf(code)
    for (const needed of needs ? neededIn(needs, isNamed) : [])
      all.add(needed)
  }
  return [...all]
}

/** Whether a node's id is a pool's */
export const isPool = (id: string) =>
  id.startsWith("pool-")

/** The note right before a row with nothing under it, if any, which leads what follows as a sub-heading would */
export const leadOf = (rows: readonly Row[], i: number) => {
  const before = rows[i - 1]
  return before && "note" in before && !before.options?.length ? before.note : undefined
}

/**
 * A program's pools: each note with courses or notes under it, in row order, with the courses under it that aren't
 * core, each course in the first pool listing it
 */
export const poolsOf = (program: Pick<Program, "rows" | "courses">): Pool[] => {
  const roles = rolesOf(program)
  const taken = new Set<string>()
  const pools: Pool[] = []
  let header: string | undefined
  const rows = program.rows ?? []
  for (const [i, row] of rows.entries()) {
    if ("header" in row)
      header = row.header
    else if ("note" in row && row.options?.length) {
      const lead = leadOf(rows, i)
      const members: string[] = []
      for (const code of row.options.flatMap(option => typeof option === "string" ? [] : option))
        if (roles.get(code) === "option" && !taken.has(code)) {
          taken.add(code)
          members.push(code)
        }
      const texts = row.options.filter((option): option is string => typeof option === "string")
      pools.push({ id: `pool-${pools.length + 1}`, note: row.note, ...header && { header }, ...lead && { lead }, ...row.credits && { credits: row.credits }, members, texts })
    }
  }
  return pools
}

/**
 * The graph of a program's core, what it needs and its pools: the edges, any closing a loop left out, each node's
 * level, the longest chain of needs before it, and each level ordered by where what it needs and what needs it sit,
 * ties with the core first, then by code, and its pools after its courses
 */
export const graphOf = (program: Pick<Program, "rows" | "courses">, needsOf: (code: string) => Req | undefined): Graph => {
  const pools = poolsOf(program)
  const poolOf = new Map(pools.flatMap(pool => pool.members.map(code => [code, pool.id] as const)))
  const named = new Set(program.courses)
  const isNamed = (code: string) => named.has(code)
  const core = program.courses.filter(code => !poolOf.has(code))
  const isCore = new Set(core)

  // The core and what it needs, however far back, members folded into their pools; and every edge: between courses,
  // members included, and into a pool for what its members need and what needs them
  const nodes = new Set(core)
  const edges: Edge[] = []
  const intoPools = new Map<string, Edge>()
  const needed = (to: string) => {
    const needs = needsOf(to)
    return needs ? [...new Set(neededIn(needs, isNamed))].filter(from => from !== to).map(from => ({ from, to, isAlternative: isAlternativeIn(needs, from) })) : []
  }
  for (const to of nodes)
    for (const edge of needed(to)) {
      const pool = poolOf.get(edge.from)
      if (pool)
        intoPools.set(`${pool} ${to}`, { from: pool, to, isAlternative: true })
      else
        nodes.add(edge.from)
      edges.push(edge)
    }
  for (const pool of pools)
    for (const member of pool.members)
      for (const edge of needed(member))
        if (nodes.has(edge.from)) {
          edges.push(edge)
          intoPools.set(`${edge.from} ${pool.id}`, { from: edge.from, to: pool.id, isAlternative: true })
        }
  const ids = [...nodes, ...pools.map(pool => pool.id)]
  const byRank = (a: string, b: string) =>
    Number(isPool(a)) - Number(isPool(b)) || Number(!isCore.has(a)) - Number(!isCore.has(b)) || byCode(a, b)
  ids.sort(byRank)
  // Every node, and every member with an edge, whose level is beside the point but whose edges must close no loop
  const all = [...ids, ...poolOf.keys()]
  const before = new Map(all.map(id => [id, [] as Edge[]]))
  for (const edge of [...edges, ...intoPools.values()])
    before.get(edge.to)!.push(edge)

  // Depth first from each node in rank order, leaving out an edge back to a node still on the path. A member's level
  // counts for nothing: what needs it sits past its pool
  const level = new Map<string, number>()
  const onPath = new Set<string>()
  const kept = new Set<Edge>()
  const visit = (id: string): number => {
    const known = level.get(id)
    if (known !== undefined)
      return known
    onPath.add(id)
    let deepest = -1
    for (const edge of before.get(id)!) {
      if (onPath.has(edge.from))
        continue
      const depth = visit(edge.from)
      if (!poolOf.has(edge.from))
        deepest = Math.max(deepest, depth)
      kept.add(edge)
    }
    onPath.delete(id)
    level.set(id, deepest + 1)
    return deepest + 1
  }
  all.forEach(visit)

  const lanes: string[][] = []
  for (const id of ids)
    (lanes[level.get(id)!] ??= []).push(id)
  // Each lane in the order of the mean place of what its nodes need, swept down the lanes, then of what needs them,
  // swept back up, so edges cross less
  const isDrawn = new Set(ids)
  const after = new Map(ids.map(id => [id, [] as Edge[]]))
  for (const edge of kept)
    if (isDrawn.has(edge.from) && isDrawn.has(edge.to))
      after.get(edge.from)!.push(edge)
  const place = new Map<string, number>()
  const placed = (lane: string[]) => lane.forEach((id, j) => place.set(id, j / Math.max(1, lane.length - 1)))
  const sweep = (lane: string[], neighbours: (id: string) => string[]) => {
    const means = new Map(lane.map(id => {
      const places = neighbours(id).map(other => place.get(other)!)
      return [id, places.length ? places.reduce((a, b) => a + b, 0) / places.length : undefined]
    }))
    lane.sort((a, b) => Number(isPool(a)) - Number(isPool(b)) || (means.get(a) ?? place.get(a)!) - (means.get(b) ?? place.get(b)!) || byRank(a, b))
    placed(lane)
  }
  lanes.forEach(placed)
  for (const lane of lanes.slice(1))
    sweep(lane, id => before.get(id)!.filter(edge => kept.has(edge) && isDrawn.has(edge.from)).map(edge => edge.from))
  for (const lane of lanes.slice(0, -1).reverse())
    sweep(lane, id => after.get(id)!.map(edge => edge.to))
  return { lanes: lanes.map(nodes => ({ nodes })), pools, edges: [...edges, ...intoPools.values()].filter(edge => kept.has(edge)) }
}

/**
 * The same graph laid out by the plan's terms: each node in the first term naming it, an alternative in the term of
 * the course it's an alternative to where the plan names only that one, and the rest, pools among them, in a last lane
 * of their own in the levels' order. Within a term, the plan's order, alternatives after
 */
export const byTerm = (graph: Graph, program: Pick<Program, "rows" | "plan">): Graph => {
  const order = new Map(graph.lanes.flatMap(lane => lane.nodes).map((id, i) => [id, i]))
  const placed = new Set<string>()
  const lanes: Lane[] = (program.plan ?? []).map(term => {
    const nodes = term.courses.filter(code => order.has(code) && !placed.has(code))
    nodes.forEach(code => placed.add(code))
    return { label: `${term.year} · ${term.term}`, nodes }
  })
  for (const row of program.rows ?? [])
    if ("course" in row) {
      const codes = row.course.flat().filter(code => order.has(code))
      const lane = lanes.find(lane => codes.some(code => lane.nodes.includes(code)))
      for (const code of codes)
        if (lane && !placed.has(code)) {
          placed.add(code)
          lane.nodes.push(code)
        }
    }
  const rest = [...order.keys()].filter(id => !placed.has(id))
  return { ...graph, lanes: [...lanes.filter(lane => lane.nodes.length), ...rest.length ? [{ label: "Not in the plan", nodes: rest }] : []] }
}

/**
 * A node's chain: what it needs, and what those need, back to nodes needing nothing, the node itself included; and
 * what it unlocks, and what those unlock in turn
 */
export const chainOf = ({ edges }: Pick<Graph, "edges">, id: string) => {
  const reach = (isForward: boolean) => {
    const found = new Set([id])
    for (const at of found)
      for (const { from, to } of edges)
        if ((isForward ? from : to) === at)
          found.add(isForward ? to : from)
    return found
  }
  const unlocks = reach(true)
  unlocks.delete(id)
  return { needs: reach(false), unlocks }
}
