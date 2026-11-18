// Final exams' times and rooms (src/courses/finals.mts), told only to a device whose person holds a verified UNH
// address, decided per request from its secret or cookie as the rooms' titles are (isVerifiedAsker). They're stored
// whole beside the models by the nightly run (scripts/map/finals.mts), never in the build, whose files anyone can
// fetch, nor in the inputs' releases. A verified device asks for a term's and is told every section's, so a section's
// page and your finals answer from one ask; anyone else is refused, and is told only the term's finals window, which
// the academic calendar gives every page. Answers are private to the asker and never cached

import { Hono } from "hono/tiny"
import { drizzle } from "drizzle-orm/d1"
import * as v from "valibot"
import { type Finals, type Told, FINALS, Finals as FinalsSchema } from "../src/courses/finals.mts"
import type { Env } from "./env.mts"
import { latestModel } from "./models.mts"
import { isVerifiedAsker } from "./social.mts"

type Worker = { Bindings: Env }

export const finals = new Hono<Worker>()

/** The finals stored last, or none while none of this shape are */
export const storedFinals = async (db: D1Database): Promise<Finals | undefined> => {
  const [stored] = await latestModel(drizzle(db), FINALS)
  const parsed = v.safeParse(FinalsSchema, stored?.state)
  return parsed.success ? parsed.output : undefined
}

const PRIVATE = { "cache-control": "private, no-store" }

finals.get("/api/finals/:term", async c => {
  if (!await isVerifiedAsker(c))
    return c.text("Exam times and rooms take a verified UNH email", 403, PRIVATE)
  const code = c.req.param("term")
  const term = (await storedFinals(c.env.DB))?.terms[code]
  return term
    ? c.json({ code, fetched: term.fetched, finals: term.finals } satisfies Told, 200, PRIVATE)
    : c.text("No finals for that term yet", 404, PRIVATE)
})
