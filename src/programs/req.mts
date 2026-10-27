// A course's prerequisites as a tree, read from the catalog's sentence for them, which Banner writes from its rules
// ("CS 515 with a minimum grade of C- and (MATH 531 or MATH 539)"), and written back as the course page's terse Needs
// line ("CS 515 (C-) and (MATH 531 or 539)"), which reads back to the same tree. A sentence that can't be read for
// sure, as one mixing "and" with "or" unbracketed, is kept whole as text rather than guessed at

/**
 * A course passed, at least at a grade other than D-, the catalog's default, or taken alongside; every one of some;
 * any one of some; or anything else, like a placement score, as the catalog words it
 */
export type Req =
  | { course: string, grade?: string, concurrent?: true }
  | { all: Req[] }
  | { any: Req[] }
  | { text: string }

/** The grade every course needs unless it says otherwise, which is left unsaid */
const DEFAULT_GRADE = "D-"

const GRADE = String.raw`[A-F][+-]?|CR|P|S`

type Token =
  | { t: "course", code: string }
  | { t: "grade", grade: string }
  | { t: "concurrent" }
  | { t: "suffix", grade?: string, concurrent: boolean }
  | { t: "and" | "or" | "," | "(" | ")" }
  | { t: "list", all: boolean }
  | { t: "text", text: string }

// Each alternative is one token; a number alone is a course of the subject before it, as the Needs line writes them
const TOKEN = new RegExp([
  String.raw`(?<course>\b[A-Z]{2,5} ?\d{3}[A-Z]{0,2}\b)(?!-)`,
  String.raw`(?<=(?:\band|\bor|,) )(?<number>\d{3}[A-Z]{0,2}\b)(?!-)`,
  String.raw`,? ?with a minimum grade of (?<grade>${GRADE})(?![\w+-])`,
  String.raw`(?<concurrent>\(?,? ?(?:which )?(?:may|must|can) be taken concurrently\)?|\(?,? ?or concurrent(?:ly)?(?: enrollment)?\)?)`,
  String.raw`\((?:(?<suffix>${GRADE})(?<also>, or concurrently)?|(?<only>or concurrently))\)`,
  String.raw`\b(?<list>all|one) of\b`,
  String.raw`(?<and>\band\b|;)`,
  String.raw`(?<or>\bor\b)`,
  String.raw`(?<op>[,()])`
].join("|"), "g")

const lex = (source: string) => {
  const tokens: Token[] = []
  let subject = ""
  let last = 0
  const text = (raw: string) => {
    const text = raw.replace(/^[\s.:]+|[\s.:]+$/g, "")
    const before = tokens.at(-1)
    if (!text)
      return
    if (before?.t === "text")
      before.text += ` ${text}`
    else
      tokens.push({ t: "text", text })
  }
  for (const match of source.matchAll(TOKEN)) {
    text(source.slice(last, match.index))
    last = match.index + match[0].length
    const { course, number, grade, concurrent, suffix, also, only, list, and, or, op } = match.groups!
    if (course) {
      const [, letters, digits] = course.match(/^([A-Z]+) ?(.*)$/)!
      subject = letters
      tokens.push({ t: "course", code: `${letters} ${digits}` })
    }
    else if (number)
      subject ? tokens.push({ t: "course", code: `${subject} ${number}` }) : text(number)
    else if (grade)
      tokens.push({ t: "grade", grade })
    else if (concurrent)
      tokens.push({ t: "concurrent" })
    else if (suffix || only)
      tokens.push({ t: "suffix", grade: suffix, concurrent: Boolean(also || only) })
    else if (list)
      tokens.push({ t: "list", all: list === "all" })
    else if (and)
      tokens.push({ t: "and" })
    else if (or)
      tokens.push({ t: "or" })
    else
      tokens.push({ t: op as "," | "(" | ")" })
  }
  text(source.slice(last))
  return tokens
}

/** A course needed, its grade left unsaid if it's the default */
const courseOf = (code: string, grade?: string, concurrent?: boolean): Req =>
  ({ course: code, ...grade && grade !== DEFAULT_GRADE ? { grade } : {}, ...concurrent ? { concurrent: true } : {} })

/** One group of a kind, or the one thing in it */
const groupOf = (all: boolean, items: Req[]): Req =>
  items.length === 1 ? items[0] : all ? { all: items } : { any: items }

/**
 * Reads a prerequisite sentence, in the catalog's words or the Needs line's, into its tree, or undefined if it can't
 * be read for sure: brackets that don't balance, two things side by side with nothing joining them, or "and" mixed
 * with "or" unbracketed, which Banner writes for rules whose grouping it lost
 */
export const parseReq = (source: string): Req | undefined => {
  const tokens = lex(source)
  let i = 0
  const peek = () => tokens[i]

  const item = (): Req | undefined => {
    const token = tokens[i++]
    if (token?.t === "(") {
      const inner = expression()
      return tokens[i++]?.t === ")" ? inner : undefined
    }
    if (token?.t === "text")
      return { text: token.text }
    if (token?.t !== "course")
      return
    let grade: string | undefined
    let concurrent = false
    for (let next = peek(); next?.t === "grade" || next?.t === "concurrent" || next?.t === "suffix"; next = tokens[++i]) {
      if (next.t !== "concurrent" && next.grade)
        grade = next.grade
      if (next.t === "concurrent" || next.t === "suffix" && next.concurrent)
        concurrent = true
    }
    return courseOf(token.code, grade, concurrent)
  }

  const expression = (): Req | undefined => {
    const head = peek()
    if (head?.t === "list") {
      i++
      const items = [item()]
      while (peek()?.t === ",") {
        i++
        items.push(item())
      }
      return items.every(Boolean) && items.length > 1 ? groupOf(head.all, items as Req[]) : undefined
    }
    const items = [item()]
    let op: "and" | "or" | undefined
    for (let next = peek(); next?.t === "and" || next?.t === "or"; next = peek()) {
      if (op && op !== next.t)
        return
      op = next.t
      i++
      // A concurrency note may close a list, as in "A and B (may be taken concurrently)", which the item before keeps
      items.push(item())
    }
    return items.every(Boolean) ? groupOf(op !== "or", items as Req[]) : undefined
  }

  const tree = expression()
  return i === tokens.length ? tree : undefined
}

/** A course's code and grade as the Needs line writes it, its subject left off if the course before has it too */
const courseText = ({ course, grade, concurrent }: Extract<Req, { course: string }>, before?: Req) => {
  const code = before && "course" in before && before.course.split(" ")[0] === course.split(" ")[0]
    ? course.split(" ")[1]
    : course
  const notes = [grade, concurrent && "or concurrently"].filter(Boolean)
  return notes.length ? `${code} (${notes.join(", ")})` : code
}

/**
 * A prerequisite tree as the course page's Needs line, text rather than elements, as it reads back to the same tree
 * (parseReq), so its lists are joined here: two things joined by "and" or "or", more as "all of" or "one
 * of" a list, groups within groups bracketed, a grade only where it isn't D-, and a subject only where it changes,
 * as "CS 416 or 417"
 */
export const renderReq = (req: Req): string => {
  if ("course" in req)
    return courseText(req)
  if ("text" in req)
    return req.text
  const all = "all" in req
  const items = all ? req.all : req.any
  const parts = items.map((item, i) =>
    "course" in item ? courseText(item, items[i - 1]) : "text" in item ? item.text : `(${renderReq(item)})`)
  return parts.length === 2
    ? parts.join(all ? " and " : " or ")
    : `${all ? "all" : "one"} of ${parts.join(", ")}`
}

/** Every course a tree names, in order, repeats included */
export const coursesIn = (req: Req): string[] =>
  "course" in req ? [req.course] : "text" in req ? [] : ("all" in req ? req.all : req.any).flatMap(coursesIn)

/** A tree with each course not among those known kept as text, as the Needs line writes it, rather than dropped */
export const resolved = (req: Req, isKnown: (code: string) => boolean): Req =>
  "course" in req ? isKnown(req.course) ? req : { text: renderReq(req) }
  : "text" in req ? req
  : "all" in req ? { all: req.all.map(item => resolved(item, isKnown)) }
  : { any: req.any.map(item => resolved(item, isKnown)) }
