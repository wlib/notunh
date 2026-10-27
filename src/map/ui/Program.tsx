/** @jsxImportSource bruh/browser */

// A program's courses by what each needs (src/programs/graph.mts): a planning view of its own, which takes the sheet's
// full height on a phone and the screen's width beside the map, apart from the campus pages. Its core, the courses
// the catalog's lists put on rows of their own or as their alternatives, and every course those need, however far
// back, each on a level one past the furthest of what it needs; and its pools, the choices listed under one note,
// each one node that opens to its courses. Where the catalog has a sample degree plan, the same nodes go by its
// terms. A phone reads the lanes top to bottom, each a wrapping row of courses; a wide panel reads them left to
// right, each a column, with every edge drawn. Tapping a course focuses its chain, what it needs back to courses
// needing nothing and what it unlocks, dimming the rest, and says what it needs, where the program lists it, and
// links to its page, with its sections: in a card below the course on a phone, so the chain stays in sight, and at
// the top on a wide screen. The same markup at every width, laid out by container queries.
//
// It shows the catalog's structure, never a degree audit: a note like "Select one course from the following:" is
// shown as the catalog words it, under the heading it's under, with a link to the program's page in the catalog for
// what's required. A program whose lists couldn't be read for sure lists the courses its requirements name instead.
// The list of programs, searched by title, opens one, and given a course, leads with those naming it

import type { BruhChild } from "bruh/browser"
import { type DerivativeNode, r, watch } from "bruh/reactive"
import { type Program, type Role, type Row, listedUnder, rolesOf } from "../../programs/program.mts"
import { type Graph, type Pool, byTerm, chainOf, graphOf, isPool } from "../../programs/graph.mts"
import type { Prereqs } from "../../programs/prereqs.mts"
import { renderReq } from "../../programs/req.mts"
import { courseOf } from "../../courses/course.mts"
import { Count, Counted, List } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import type { Page } from "../state/page.mts"
import { state } from "../state/map.mts"
import { detent } from "./sheet.mts"
import { Group } from "./Courses.tsx"
import { Go, Head, Line, LinkLine, Row as RowView } from "./Pages.tsx"

type ProgramPage = Extract<Page, { kind: "program" }>

const KINDS: Record<Program["kind"], string> = { major: "Major", option: "Option", minor: "Minor", cognate: "Cognate", program: "Program" }

/** How a course is listed, in a word for its focus */
const ROLES: Record<Role | "needed", string> = { listed: "Listed", or: "An alternative", option: "A choice", needed: "Needed first, not listed" }

/** How many programs the list shows at most, past which typing narrows it */
const SHOWN = 40

/** The program page shown, followed as its focus changes in place */
const shown = (page: ProgramPage) =>
  r(() => {
    const now = state.page.value
    return now?.kind === "program" ? now : page
  })

/** Programs whose titles have every word typed, by title */
const matching = (programs: NonNullable<typeof state.programs.value>["programs"], text: string) => {
  const words = text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return programs
    .filter(({ title }) => words.every(word => title.toLocaleLowerCase().includes(word)))
    .sort((a, b) => a.title.localeCompare(b.title))
}

/** A program as a row, which opens it, focused on a course if one's given. Its title says its kind, "Computer Science Minor" */
const ProgramRow = ({ program, course }: { program: { slug: string, title: string }, course?: string }) =>
  <RowView what={program.title} standing="›" onclick={() => state.go({ kind: "program", slug: program.slug, ...course && { course } })} />

/** The list of programs, searched by title, those naming a course first where one's given */
const Picker = ({ course }: { course?: string }) => {
  const query = r("")
  const field: HTMLInputElement = <input type="search" placeholder="Search programs" aria-label="Search programs" oninput={() => query.value = field.value} />
  return (
    <>
      <Head title={course ? `Programs with ${course}` : "Programs"} name="Programs" />
      <label class="field">{field}</label>
      {r(() => {
        const list = state.programs.value
        if (list === undefined)
          return <p class="muted">Loading programs…</p>
        if (list === null)
          return <p class="muted">No programs in this build.</p>
        const naming = course ? (list.courses[course] ?? []).map(i => list.programs[i]).sort((a, b) => a.title.localeCompare(b.title)) : []
        const found = matching(list.programs, query.value)
        return (
          <>
            {course && !query.value && (naming.length
              ? <ul class="rows" aria-label={`Programs with ${course}`}>{naming.map(program => <ProgramRow program={program} course={course} />)}</ul>
              : <p class="muted">No program's lists name {course}.</p>)}
            {(query.value || !course) && <>
              <p class="view-label"><Counted value={found.length} one="program" other="programs" /></p>
              <ul class="rows" aria-label="Programs">{found.slice(0, SHOWN).map(program => <ProgramRow program={program} course={course} />)}</ul>
              {found.length > SHOWN && <p class="muted">Type to narrow these.</p>}
            </>}
          </>
        )
      })}
      <p class="view-foot muted">Durham's undergraduate programs, from UNH's catalog</p>
    </>
  )
}

/** A course's code and title, as a node and a row say them */
const titleOf = (program: Program, code: string) =>
  program.titles[code]

/** The edges drawn for a graph, the chain focused on lit, between the nodes as they're laid out now; none into an open pool, whose members' are drawn instead */
const drawEdges = (canvas: HTMLElement, svg: SVGSVGElement, graph: Graph, open: ReadonlySet<string>, chain?: ReturnType<typeof chainOf>, focus?: string) => {
  const origin = canvas.getBoundingClientRect()
  const boxes = new Map([...canvas.querySelectorAll<HTMLElement>(".node")].map(node => [node.dataset.code!, node.getBoundingClientRect()]))
  const isAcross = getComputedStyle(canvas.querySelector(".levels")!).flexDirection === "row"
  svg.setAttribute("viewBox", `0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`)
  svg.setAttribute("width", `${canvas.scrollWidth}`)
  svg.setAttribute("height", `${canvas.scrollHeight}`)
  const paths = graph.edges.flatMap(({ from, to, isAlternative }) => {
    const [a, b] = [boxes.get(from), boxes.get(to)]
    if (!a || !b || open.has(from) || open.has(to))
      return []
    const [x1, y1, x2, y2] = isAcross
      ? [a.right, a.top + a.height / 2, b.left, b.top + b.height / 2]
      : [a.left + a.width / 2, a.bottom, b.left + b.width / 2, b.top]
    const [sx, sy, tx, ty] = [x1 - origin.left, y1 - origin.top, x2 - origin.left, y2 - origin.top]
    const bend = isAcross ? `C ${(sx + tx) / 2} ${sy} ${(sx + tx) / 2} ${ty}` : `C ${sx} ${(sy + ty) / 2} ${tx} ${(sy + ty) / 2}`
    const isOn = chain !== undefined && ((chain.needs.has(from) && chain.needs.has(to)) || ((from === focus || chain.unlocks.has(from)) && chain.unlocks.has(to)))
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", `M ${sx} ${sy} ${bend} ${tx} ${ty}`)
    path.setAttribute("class", ["edge", isAlternative && "alternative", isOn && "on"].filter(Boolean).join(" "))
    return [path]
  })
  svg.replaceChildren(...paths)
}

/** A course focused on: how it's listed and where, what it needs, what it unlocks here, and its page, with its sections */
const Focused = ({ program, prereqs, graph, code, roles, set }: { program: Program, prereqs: Prereqs, graph: Graph, code: string, roles: Map<string, Role>, set: (code?: string) => void }) => {
  const { needs } = prereqs.courses[code] ?? {}
  const unlocks = graph.edges.filter(edge => edge.from === code && !isPool(edge.to)).map(edge => edge.to)
  const where = listedUnder(program, code)
  const role = roles.get(code)
  return (
    <div class="program-focus">
      <div class="program-focus-head">
        <p class="view-label">{role ? ROLES[role] : ROLES.needed}{where?.header && <> · {where.header}</>}</p>
        <button type="button" class="clear" aria-label="Clear focus" onclick={() => set(undefined)}><Icon name="close" /></button>
      </div>
      <p class="view-when">{code}{titleOf(program, code) && <span class="muted"> · {titleOf(program, code)}</span>}</p>
      {where?.note && <p class="muted">Under “{where.note}”</p>}
      <div class="lines">
        <Line label="Needs"><span class="muted">{needs ? renderReq(needs) : "Nothing listed"}</span></Line>
        <Line label="Unlocks here">
          {unlocks.length
            ? <span><List items={unlocks.map(to => <button type="button" class="go" onclick={() => set(to)}>{to}</button>)} /></span>
            : <span class="muted">Nothing here</span>}
        </Line>
        <Offered code={code} />
      </div>
    </div>
  )
}

/** The terms a course has sections in, live and to come, once they've loaded, which lead to its page */
const Offered = ({ code }: { code: string }) => {
  state.wantCourses()
  state.wantLater()
  return r(() => {
    const terms = [...state.courses.value?.terms ?? [], ...state.later.value ?? []]
      .filter(term => term.sections.some(section => courseOf(section) === code))
    if (!state.courses.value)
      return <Line label="Sections"><span class="muted">…</span></Line>
    return (
      <Line label="Sections">
        <Go to={{ kind: "course", code }}>{terms.length ? <List items={terms.map(term => term.name)} /> : "None listed"} ›</Go>
      </Line>
    )
  })
}

type Layout = "levels" | "terms"

/** The graph: its lanes of courses and pools, the edges between, and the chain focused on */
const GraphView = ({ program, prereqs, page, layout }: { program: Program, prereqs: Prereqs, page: DerivativeNode<ProgramPage>, layout: DerivativeNode<Layout> }) => {
  const levels = graphOf(program, code => prereqs.courses[code]?.needs)
  const graph = r(() => layout.value === "terms" ? byTerm(levels, program) : levels)
  const roles = rolesOf(program)
  const poolOf = new Map(levels.pools.flatMap(pool => pool.members.map(code => [code, pool] as const)))
  const drawn = new Set([...levels.lanes.flatMap(lane => lane.nodes), ...poolOf.keys()])
  const focus = r(() => {
    const code = page.value.course
    return code && drawn.has(code) ? code : undefined
  })
  /** The pools open to their members: a focused member's from the start, as one opened from its course's page */
  const open = r(new Set(poolOf.has(focus.peek() ?? "") ? [poolOf.get(focus.peek()!)!.id] : []))
  const toggle = (id: string) => {
    const next = new Set(open.peek())
    next.has(id) ? next.delete(id) : next.add(id)
    open.value = next
  }
  watch([focus], () => {
    const pool = focus.value && poolOf.get(focus.value)
    if (pool && !open.peek().has(pool.id))
      open.value = new Set([...open.peek(), pool.id])
  })
  const chain = r(() => focus.value === undefined ? undefined : chainOf(levels, focus.value))
  const set = (code?: string) =>
    state.amend({ ...page.peek(), course: code })
  /** How a node stands to the chain focused on: focused, needed, unlocked, or out of it */
  const standing = (id: string) =>
    r(() => {
      const shown = chain.value
      return !shown ? undefined : id === focus.value ? "focus" : shown.needs.has(id) ? "needs" : shown.unlocks.has(id) ? "unlocks" : "out"
    })
  const card = (code: string) =>
    <Focused program={program} prereqs={prereqs} graph={levels} code={code} roles={roles} set={set} />

  const Course = ({ code }: { code: string }) =>
    <>
      <li>
        <button
          type="button"
          class={`node ${roles.get(code) ?? "needed"}`}
          data-code={code}
          data-chain={standing(code)}
          aria-pressed={r(() => String(focus.value === code))}
          onclick={() => set(focus.peek() === code ? undefined : code)}
        >
          <strong>{code}</strong>
          {titleOf(program, code) && <span class="truncate">{titleOf(program, code)}</span>}
        </button>
      </li>
      {/* The focused course's card follows it on a phone, where the wide screen's card at the top is hidden */}
      {r(() => focus.value === code && <li class="focus-inline">{card(code)}</li>)}
    </>

  const PoolNode = ({ pool }: { pool: Pool }) =>
    <li class="pool">
      <button
        type="button"
        class="node pool"
        data-code={pool.id}
        data-chain={standing(pool.id)}
        aria-expanded={r(() => String(open.value.has(pool.id)))}
        onclick={() => toggle(pool.id)}
      >
        <strong>{pool.lead ? <>{pool.lead} <span class="muted">· {pool.note}</span></> : pool.note}</strong>
        {/* Credits as the catalog writes them, "3-4" as often as "4", so they're its words, not a number to format */}
        <span>{pool.header && <>{pool.header} · </>}<Counted value={pool.members.length + pool.texts.length} one="choice" other="choices" />{pool.credits && <> · {pool.credits} cr</>}</span>
      </button>
      {r(() => open.value.has(pool.id) &&
        <ul class="nodes members" aria-label={pool.note}>
          {pool.texts.map(text => <li><p class="muted node-text">{text}</p></li>)}
          {pool.members.map(code => <Course code={code} />)}
        </ul>
      )}
    </li>

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("class", "edges")
  svg.setAttribute("aria-hidden", "true")
  const canvas: HTMLElement =
    <div class="graph-canvas">
      {svg}
      {r(() =>
        <ol class="levels" style={`--lanes: ${graph.value.lanes.length}`}>
          {graph.value.lanes.map((lane, i) =>
            <li class="level">
              <h3 class="eyebrow">{lane.label ?? <>Level <Count value={i + 1} /></>}</h3>
              <ul class="nodes">
                {lane.nodes.map(id => isPool(id) ? <PoolNode pool={levels.pools.find(pool => pool.id === id)!} /> : <Course code={id} />)}
              </ul>
            </li>
          )}
        </ol>
      )}
    </div> as HTMLElement

  const redraw = () =>
    canvas.isConnected && drawEdges(canvas, svg, levels, open.peek(), chain.peek(), focus.peek())
  const sizes = new ResizeObserver(() => requestAnimationFrame(redraw))
  sizes.observe(canvas)
  watch([chain, open, graph], () => void requestAnimationFrame(redraw))
  // The focused course scrolled into view, as one opened from a course's page is
  requestAnimationFrame(() => focus.peek() && canvas.querySelector(`[data-code="${focus.peek()}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }))

  // The notes with nothing under them, apart from one leading a pool, which the pool's node says
  const also = (program.rows ?? []).flatMap((row, i, rows) => {
    const next = rows[i + 1]
    if (!("note" in row) || row.options?.length || (next && "note" in next && next.options?.length))
      return []
    const header = rows.slice(0, i).reverse().find(row => "header" in row)
    return [{ header: header && "header" in header ? header.header : undefined, note: row.note, credits: row.credits }]
  })
  return (
    <div class="graph-view">
      {r(() => focus.value && <div class="focus-top">{card(focus.value)}</div>)}
      <div class={r(() => focus.value ? "graph focused" : "graph")} role="group" aria-label={r(() => layout.value === "terms" ? "Courses by term" : "Courses by prerequisite level")}>{canvas}</div>
      {also.length > 0 &&
        <div class="program-also">
          <h3 class="eyebrow">Also listed</h3>
          {also.map(({ header, note, credits }) => <p>{header && <span class="muted">{header} · </span>}{note}{credits && <span class="muted"> · {credits} cr</span>}</p>)}
        </div>}
    </div>
  )
}

/** A program's rows as the catalog lays them out: headings, courses and their alternatives, and notes with what's under them */
const Rows = ({ program, rows }: { program: Program, rows: Row[] }) =>
  <div class="program-rows">
    {rows.map(row =>
      "header" in row ? <h3 class="eyebrow">{row.header}</h3> :
      "course" in row ?
        <ul class="rows">
          <CourseRow program={program} item={row.course[0]} credits={row.credits} />
          {row.course.slice(1).map(item => <CourseRow program={program} item={item} prefix="or" />)}
        </ul> :
        <div class="program-note">
          {/* Credits as the catalog writes them, "3-4" as often as "4", so they're its words, not a number to format */}
          <p>{row.note}{row.credits && <span class="muted"> · {row.credits} cr</span>}</p>
          {row.options && <ul class="rows">{row.options.map(option =>
            typeof option === "string" ? <li><p class="muted">{option}</p></li> : <CourseRow program={program} item={option} />
          )}</ul>}
        </div>
    )}
  </div>

/** Courses taken together, as a row that opens the first's page */
const CourseRow = ({ program, item, credits, prefix }: { program: Program, item: string[], credits?: string, prefix?: string }) =>
  <RowView
    time={<>{prefix && <small>{prefix}</small>}{item.join(" & ")}</>}
    what={item.map(code => titleOf(program, code) ?? code).join(" & ")}
    standing={credits && `${credits} cr`}
    onclick={() => state.go({ kind: "course", code: item[0] })}
  />

/** The courses a program's requirements name, for one whose lists couldn't be read for sure */
const Named = ({ program }: { program: Program }) =>
  <>
    <p class="muted">The courses its lists name; how they're required is the catalog's to say.</p>
    <ul class="rows">{program.courses.map(code => <RowView time={code} what={titleOf(program, code) ?? ""} standing="›" onclick={() => state.go({ kind: "course", code })} />)}</ul>
  </>

type View = Layout | "list"

/** A program's page: its graph by level or by term, or the courses named, its lists as the catalog has them, and the catalog's page */
const Loaded = ({ program, page }: { program: Program, page: DerivativeNode<ProgramPage> }) => {
  const view = r<View>("levels")
  const layout = r<Layout>(() => view.value === "terms" ? "terms" : "levels")
  const Chip = ({ is, children }: { is: View, children?: BruhChild }) =>
    <button type="button" class="chip" aria-pressed={r(() => String(view.value === is))} onclick={() => view.value = is}>{children}</button>
  return (
    <>
      <Head kind={<>{KINDS[program.kind]} · Catalog {program.year}</>} title={program.title} name={program.title.replace(/\s*\(.*\)$/, "")} />
      {program.rows
        ? <>
            <div class="chips" role="group" aria-label="Show">
              <Chip is="levels">By prerequisites</Chip>
              {program.plan && <Chip is="terms">By term</Chip>}
              <Chip is="list">As listed</Chip>
            </div>
            {r(() => {
              const prereqs = state.prereqs.value
              if (view.value === "list")
                return <Rows program={program} rows={program.rows!} />
              return prereqs ? <GraphView program={program} prereqs={prereqs} page={page} layout={layout} /> : <p class="muted">Loading prerequisites…</p>
            })}
          </>
        : <Named program={program} />}
      <p class="view-foot muted">Not a degree audit · <a class="go" href={program.url} target="_blank" rel="noopener">UNH's {program.year} catalog ›</a></p>
    </>
  )
}

/** A program's page, or the list of them */
export const ProgramView = ({ page }: { page: ProgramPage }) => {
  state.wantPrograms()
  // A planning view, as tall as the sheet goes
  detent.value = "tall"
  const asked = shown(page)
  if (!page.slug)
    return <Picker course={page.course} />
  const program = r<Program | null>()
  watch([state.programs], () => {
    const listed = state.programs.value?.programs.find(({ slug }) => slug === page.slug)
    if (state.programs.value === null || (state.programs.value && !listed))
      program.value = null
    else if (listed)
      state.programIn(listed.file).then(loaded => program.value = loaded, () => program.value = null)
  })
  return r(() =>
    program.value === undefined ? <p class="muted">Loading the program…</p> :
    program.value === null      ? <><Head title={page.slug!} /><p class="muted">No such program in this build.</p></> :
                                  <Loaded program={program.value} page={asked} />
  )
}

/** A course's programs, as its page's line: the one naming it, opened focused on it, or how many, which the list of them shows */
export const ProgramsLine = ({ code }: { code: string }) => {
  state.wantPrograms()
  return r(() => {
    const list = state.programs.value
    if (!list)
      return null
    const naming = (list.courses[code] ?? []).map(i => list.programs[i])
    if (!naming.length)
      return null
    return naming.length === 1
      ? <LinkLine to={{ kind: "program", slug: naming[0].slug, course: code }}>In {naming[0].title}</LinkLine>
      : <LinkLine to={{ kind: "program", course: code }}>In <Counted value={naming.length} one="program" other="programs" /></LinkLine>
  })
}

/** Search's programs: those whose titles have every word typed */
export const ProgramResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const text = query.value.trim()
    if (text.length < 3)
      return null
    state.wantPrograms()
    const list = state.programs.value
    const found = list ? matching(list.programs, text) : []
    return found.length > 0 && <Group label="Programs">{found.slice(0, 3).map(program => <ProgramRow program={program} />)}</Group>
  })
