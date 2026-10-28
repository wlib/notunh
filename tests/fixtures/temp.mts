// Folders for a test to write in, each removed after the test, and a copy of the fixtures' data (tests/fixtures/data/),
// laid out as the repository is, for the scripts that stage, bundle and install it

import { afterEach } from "vitest"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DATA = new URL("data/", import.meta.url)

const made: string[] = []

/** An empty folder of its own, gone after the test */
export const tempFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "notunh-test-"))
  made.push(folder)
  return folder
}

/** The fixtures' data as a folder of its own, to change as a test likes */
export const dataCopy = async () => {
  const folder = await tempFolder()
  await cp(DATA, folder, { recursive: true })
  return folder
}

/** The fixtures' own path to a file, for a test to copy from */
export const dataFile = (path: string) =>
  new URL(path, DATA)

afterEach(() => Promise.all(made.splice(0).map(folder => rm(folder, { recursive: true, force: true }))))
