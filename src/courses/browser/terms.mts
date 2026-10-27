// The terms on a page: the index its head names (courses.json, through latest in src/shell/build.mts), and each live
// term's file, loaded only once something asks for courses, so the sections never hold up a page's first load; and
// the terms still to come, loaded only once a course's page asks for them. The files are named by their content, so
// immutable (src/shell/load.mts), and a newer index's are loaded and swapped in as they come. What's derived from the
// live terms, people, search and the rooms' schedule, is made once per set of terms

import { type DerivativeNode, type Reactive, r, watch } from "bruh/reactive"
import { type CoursesIndex, type Term, type TermEntry, TermFile, activeTerms, termOf } from "../course.mts"
import { createPeople } from "../people.mts"
import { createCourseSearch } from "../search.mts"
import { createSchedule } from "../rooms.mts"
import { dayStart, localDay } from "../../shared/time.mts"
import { jsonOf, loadImmutable } from "../../shell/load.mts"
import { today } from "../../shell/lifecycle.mts"
import { distinct, isSameList } from "../../shell/state.mts"

const TERM = jsonOf(TermFile)

/** A term's sections, loaded however many tries it takes (loadImmutable), joined with its entry in the index */
const loadTerm = async (index: CoursesIndex, entry: TermEntry, options: { signal?: AbortSignal, onError?: (error: unknown) => void } = {}): Promise<Term> =>
  termOf(index, entry, await loadImmutable(entry.file, TERM, options))

/** The terms of an index that are yet to start and aren't live yet, as a course's page shows the next term's sections */
export const laterTerms = (index: CoursesIndex, now: number) => {
  const live = activeTerms(index.terms, now)
  return index.terms.filter(entry => !live.includes(entry) && entry.from > localDay(now))
}

/** The live terms and everything made of them */
const derive = (index: CoursesIndex, terms: Term[]) => {
  const people = createPeople(terms)
  return { calendar: index.calendar, terms, people, search: createCourseSearch(terms, people), schedule: createSchedule(terms, index.calendar) }
}
export type Courses = ReturnType<typeof derive>

/**
 * Some terms of whichever index is newest, as `termsOf` picks them for a day, loaded once `isWanted` first holds and
 * kept loaded after, each set made into what's wanted of it, with whether a load is failing meanwhile. Undefined
 * until the first set loads
 */
const loaded = <T,>(index: DerivativeNode<CoursesIndex>, isWanted: Reactive<boolean>, termsOf: (index: CoursesIndex, now: number) => TermEntry[], made: (index: CoursesIndex, terms: Term[]) => T) => {
  const value = r<T>()
  const hasFailed = r(false)
  let wanted = false
  const files = distinct(() => {
    wanted ||= isWanted.value
    // A newer index with the same files may have a newer calendar, and the files load again from the cache
    return wanted ? [String(index.value.built), ...termsOf(index.value, dayStart(today.value)).map(({ file }) => file)] : []
  }, isSameList)
  watch([files], () => {
    if (!wanted)
      return
    const loading = new AbortController()
    const from = index.peek()
    Promise.all(termsOf(from, dayStart(today.peek())).map(entry => loadTerm(from, entry, { signal: loading.signal, onError: () => hasFailed.value = true })))
      .then(terms => {
        hasFailed.value = false
        value.value = made(from, terms)
      }, () => {})
    return () => loading.abort()
  })
  return { value, hasFailed }
}

/** The live terms of whichever index is newest and what's made of them, loaded once `isWanted` first holds */
export const createCourses = (index: DerivativeNode<CoursesIndex>, isWanted: Reactive<boolean>) => {
  const { value: courses, hasFailed } = loaded(index, isWanted, (index, now) => activeTerms(index.terms, now), derive)
  return { courses, hasFailed }
}

/** The terms still to come of whichever index is newest, loaded once `isWanted` first holds */
export const createLaterTerms = (index: DerivativeNode<CoursesIndex>, isWanted: Reactive<boolean>) =>
  loaded(index, isWanted, laterTerms, (_, terms) => terms).value
