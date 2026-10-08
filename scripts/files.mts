// What build steps ask of the files they write

import { access } from "node:fs/promises"

export const exists = (url: URL) =>
  access(url).then(() => true, () => false)

/** Whether a file a build step writes is already there and asked to be kept, with --if-missing */
export const isKept = async (output: URL) =>
  process.argv.includes("--if-missing") && await exists(output)
