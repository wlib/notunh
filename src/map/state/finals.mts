// Your finals (src/courses/finals.mts), as the Worker tells a device with a verified UNH address: each live term's,
// asked for once the device is known to be one (You.tsx) and kept on this device alone, so a section's page and your
// finals show offline in finals week too. The Worker refusing, as once the address is forgotten, forgets them here.
// What's read of them: a section's sittings, and your saved sections' as events, soonest first, with those that clash.
// Reactive values only, no DOM

import { type DerivativeNode, r } from "bruh/reactive"
import * as v from "valibot"
import { type CoursesIndex, type CourseEvent, type Section, type Term, activeTerms } from "../../courses/course.mts"
import { type Final, Told, conflicting, eventOfFinal, finalsOf } from "../../courses/finals.mts"
import type { Found } from "../../courses/search.mts"
import { finalsIn } from "../../social/browser/api.mts"
import { store, stored } from "../../shell/state.mts"

/** Where this device keeps the finals it's been told, by term, never synced */
const KEPT = "finals"

const Kept = v.record(v.string(), Told)

/** A sitting of one of your finals: its section, and the event it is */
export type YourFinal = Found & { final: Final, event: CourseEvent, clashes: boolean }

export const createFinals = ({ coursesIndex, saved, now }: { coursesIndex: DerivativeNode<CoursesIndex>, saved: DerivativeNode<Found[]>, now: DerivativeNode<number> }) => {
  const told = r<Record<string, Told>>((() => {
    const kept = v.safeParse(Kept, stored(KEPT))
    return kept.success ? kept.output : {}
  })())
  const keep = (finals: Record<string, Told>) => {
    told.value = finals
    store(KEPT, finals)
  }

  /** Asks the Worker for each live term's finals, as a device it says is verified; a refusal forgets every term's */
  const askFinals = () => {
    const codes = activeTerms(coursesIndex.peek().terms, now.peek() * 1000).map(({ code }) => code)
    for (const code of codes)
      finalsIn(code).then(answer => {
        if (answer === null)
          return keep({})
        const { [code]: _, ...rest } = told.peek()
        keep(answer ? { ...rest, [code]: answer } : rest)
      }, () => {})
  }

  /** Whether the Worker has told this device a term's finals */
  const hasFinals = (term: Pick<Term, "code">) =>
    told.value[term.code] !== undefined

  /** A section's final, each sitting, once told */
  const finalsOfSection = (term: Pick<Term, "code">, section: Section) =>
    finalsOf(told.value[term.code]?.finals, section)

  /** Your saved sections' finals, each sitting, soonest first, those overlapping another's said to clash */
  const yourFinals = r((): YourFinal[] => {
    const sittings = saved.value.flatMap(({ term, section }) =>
      finalsOf(told.value[term.code]?.finals, section).map(final => ({ term, section, final, crn: section.crn, event: eventOfFinal(term, section, final) })))
    const clashing = conflicting(sittings)
    return sittings.map(({ crn, ...sitting }, i) => ({ ...sitting, clashes: clashing.has(sittings[i]) }))
      .sort((a, b) => a.event.start - b.event.start)
  })

  return { askFinals, hasFinals, finalsOfSection, yourFinals }
}
