// The prerequisites and programs on a page: the files the index names (src/programs/prereqs.json, which a page's head
// names, through latest in src/shell/build.mts), each loaded only once a course or a program is opened, so none holds
// up a page's first load, as the courses' terms are (src/courses/browser/terms.mts). Each is named by its content, so
// immutable (src/shell/load.mts)

import { type DerivativeNode, type Reactive, r, watch } from "bruh/reactive"
import { Prereqs, type PrereqsIndex } from "../prereqs.mts"
import { Program, Programs } from "../program.mts"
import { jsonOf, loadImmutable } from "../../shell/load.mts"

const PREREQS = jsonOf(Prereqs)

/** The index's prerequisites, loaded however many tries it takes, or none if the inputs had none */
const loadPrereqs = async (index: PrereqsIndex, options?: Parameters<typeof loadImmutable>[2]): Promise<Prereqs> =>
  index.file ? loadImmutable(index.file, PREREQS, options) : { fetched: index.fetched, courses: {} }

/** The prerequisites of whichever index is newest, loaded once `isWanted` first holds; undefined until they load */
export const createPrereqs = (index: DerivativeNode<PrereqsIndex>, isWanted: Reactive<boolean>) => {
  const prereqs = r<Prereqs>()
  let wanted = false
  watch([isWanted, index], () => {
    wanted ||= isWanted.value
    if (!wanted)
      return
    const loading = new AbortController()
    loadPrereqs(index.value, { signal: loading.signal, onError: () => {} }).then(loaded => prereqs.value = loaded, () => {})
    return () => loading.abort()
  })
  return prereqs
}

const PROGRAMS = jsonOf(Programs)
const PROGRAM = jsonOf(Program)

/** The list of programs of whichever index is newest, loaded once `isWanted` first holds; undefined until it loads, null if there's none */
export const createPrograms = (index: DerivativeNode<PrereqsIndex>, isWanted: Reactive<boolean>) => {
  const programs = r<Programs | null>()
  let wanted = false
  watch([isWanted, index], () => {
    wanted ||= isWanted.value
    const file = index.value.programs
    if (!wanted)
      return
    if (!file)
      return void (programs.value = null)
    const loading = new AbortController()
    loadImmutable(file, PROGRAMS, { signal: loading.signal, onError: () => {} }).then(loaded => programs.value = loaded, () => {})
    return () => loading.abort()
  })
  return programs
}

/** A program's file, loaded however many tries it takes */
export const loadProgram = (file: string, options?: Parameters<typeof loadImmutable>[2]): Promise<Program> =>
  loadImmutable(file, PROGRAM, options)
