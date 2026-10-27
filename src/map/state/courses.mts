// The courses on the map, each loaded only once something asks: the live terms (src/courses/browser/terms.mts), for
// search, a section's, person's, room's, course's or place's page, a saved section, or a class reminder; the terms to
// come, for a course's page or one of their sections; the prerequisites, for a section's or course's page; the
// programs' list, for a course's or program's page, and each program's file as it's opened. And the sections saved
// (src/courses/saved.mts), with your next class and how a class reminder's queue resolves. Classes are never markers
// or rows in the week: only your next class is, in Yours. Reactive values only, no DOM

import { type DerivativeNode, r } from "bruh/reactive"
import { createCourses, createLaterTerms, laterTerms } from "../../courses/browser/terms.mts"
import { SAVED, nextOf, parseKey, readSaved, resolverOf, savedIn, withSaved, withoutSaved } from "../../courses/saved.mts"
import type { Found } from "../../courses/search.mts"
import { createPrereqs, createPrograms, loadProgram } from "../../programs/browser/prereqs.mts"
import type { Program } from "../../programs/program.mts"
import type { Resolver } from "../../reminders/queue.mts"
import { dayStart } from "../../shared/time.mts"
import { today } from "../../shell/lifecycle.mts"
import type { MapData } from "./data.mts"
import { remembered } from "../../shell/state.mts"

export const createCoursesState = ({ coursesIndex, prereqsIndex, now }: Pick<MapData, "coursesIndex" | "prereqsIndex"> & { now: DerivativeNode<number> }) => {
  /** Whether anything has asked for the courses yet */
  const isAsked = r(false)
  const savedKeys = remembered<string[]>(SAVED, readSaved)
  const { courses, hasFailed: coursesFailed } = createCourses(coursesIndex, r(() => isAsked.value || savedKeys.value.length > 0))

  /** Loads the live terms, if nothing has yet */
  const wantCourses = () => {
    if (!isAsked.peek())
      isAsked.value = true
  }

  /** The terms still to come, as the index lists them, and once wanted, loaded */
  const laterAsked = r(false)
  const later = createLaterTerms(coursesIndex, laterAsked)
  const laterListed = r(() => laterTerms(coursesIndex.value, dayStart(today.value)))
  const wantLater = () => {
    if (!laterAsked.peek())
      laterAsked.value = true
  }

  /** The sections saved here among the live terms, each class once: a term past its end has dropped out */
  const saved = r((): Found[] => courses.value ? savedIn(savedKeys.value, courses.value.terms) : [])
  const save = (found: Found) =>
    savedKeys.value = withSaved(savedKeys.peek(), found)
  const unsave = (found: Found) =>
    savedKeys.value = withoutSaved(savedKeys.peek(), found)

  /** Your next saved class to start, for Yours */
  const nextClass = r(() => courses.value && nextOf(saved.value, courses.value.calendar, now.value * 1000))

  /** A class reminder's visits to come, by its section's key, from the courses as they are now, or nothing while its term is still to load */
  const resolveClass: Resolver = key => {
    const live = courses.peek()
    if (!live)
      return
    const code = parseKey(key)?.term
    const isLater = laterListed.peek().some(term => term.code === code)
    if (isLater)
      wantLater()
    const terms = isLater ? later.peek() : live.terms
    return terms && resolverOf(terms, live.calendar, () => now.peek() * 1000)(key)
  }

  /** The prerequisites, once a page has wanted them, swapped for a newer index's as it comes */
  const prereqsAsked = r(false)
  const prereqs = createPrereqs(prereqsIndex, prereqsAsked)
  const wantPrereqs = () => {
    if (!prereqsAsked.peek())
      prereqsAsked.value = true
  }

  /** The list of programs, once a page has wanted it, and each program's file by its own, loaded once and kept */
  const programsAsked = r(false)
  const programs = createPrograms(prereqsIndex, programsAsked)
  const wantPrograms = () => {
    wantPrereqs()
    if (!programsAsked.peek())
      programsAsked.value = true
  }
  const programFiles = new Map<string, Promise<Program>>()
  const programIn = (file: string) => {
    if (!programFiles.has(file))
      programFiles.set(file, loadProgram(file, { onError: () => {} }))
    return programFiles.get(file)!
  }

  return { courses, coursesFailed, wantCourses, later, laterTerms: laterListed, wantLater, savedKeys, saved, save, unsave, nextClass, resolveClass, prereqs, wantPrereqs, programs, wantPrograms, programIn }
}
