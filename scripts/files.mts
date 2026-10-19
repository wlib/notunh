// What build steps ask of the files they write, and the fixtures that stand in for upstream when there's no network

import { access, cp } from "node:fs/promises"

export const exists = (url: URL) =>
  access(url).then(() => true, () => false)

/** Whether a file a build step writes is already there and asked to be kept, with --if-missing */
export const isKept = async (output: URL) =>
  process.argv.includes("--if-missing") && await exists(output)

/**
 * A build with NOTUNH_OFFLINE set, as pull requests are checked, which fetches nothing: every data file comes from
 * the fixtures, and nothing is learned
 */
export const isOffline = Boolean(process.env.NOTUNH_OFFLINE)

/** Small, real-shaped copies of every data file, laid out as the repository is, made by tests/fixtures/make.mts */
export const FIXTURES = new URL("../tests/fixtures/data/", import.meta.url)

/** Copies a fixture, a file or a whole folder, by its path in the repository, to where the real one goes */
export const fromFixtures = (path: string) =>
  cp(new URL(path, FIXTURES), new URL(`../${path}`, import.meta.url), { recursive: true })
