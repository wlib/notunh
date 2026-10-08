// Every static member and global object property the app uses, like AbortSignal.any or navigator.wakeLock,
// against MDN's compatibility data for the oldest browsers in package.json. Neither TypeScript nor the build's
// syntax lowering knows which browsers have which APIs. Anything used as `thing?.member` checks for itself, so
// it's left alone

import { test, expect } from "vitest"
import { readFileSync, globSync } from "node:fs"
import browserslist from "browserslist"
import bcd, { type CompatStatement, type Identifier } from "@mdn/browser-compat-data"

/** browserslist's names for MDN's */
const BROWSERS: Record<string, string> = {
  safari:  "safari",
  ios_saf: "safari_ios",
  chrome:  "chrome",
  and_chr: "chrome_android",
  firefox: "firefox",
  edge:    "edge"
}

// The interfaces behind the globals that are instances rather than constructors
const INSTANCES: Record<string, string> = {
  navigator:   "Navigator",
  document:    "Document",
  location:    "Location",
  history:     "History",
  performance: "Performance",
  caches:      "CacheStorage",
  crypto:      "Crypto",
  self:        "Window",
  window:      "Window"
}

const version = (text: string) =>
  text.replace("≤", "").split(".").map(Number)

const isAtLeast = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0))
      return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

// The oldest version of each browser the app supports
const oldest = new Map<string, number[]>()
for (const entry of browserslist()) {
  const [name, range] = entry.split(" ")
  const browser = BROWSERS[name]
  const low = version(range.split("-")[0])
  if (browser && (!oldest.has(browser) || isAtLeast(oldest.get(browser)!, low)))
    oldest.set(browser, low)
}

const compatOf = (receiver: string, member: string): CompatStatement | undefined => {
  const instance = INSTANCES[receiver]
  const entries: (Identifier | undefined)[] = instance
    ? [bcd.api[instance]?.[member]]
    : [bcd.api[receiver]?.[`${member}_static`], bcd.api[receiver]?.[member], bcd.javascript.builtins[receiver]?.[member]]
  return entries.find(entry => entry?.__compat)?.__compat
}

/** The browsers too old for an API, with the version each first has it in */
const tooOld = (compat: CompatStatement) =>
  [...oldest].flatMap(([browser, low]) => {
    const [support] = [compat.support[browser as keyof typeof compat.support]].flat()
    const added = support?.version_added
    const isSupported =
      typeof added === "string" && added !== "preview" && !support!.partial_implementation && !support!.flags &&
      isAtLeast(low, version(added))
    return isSupported ? [] : [`${browser} ${low.join(".")} (added in ${added || "none"})`]
  })

test("the app only uses APIs every supported browser has, or checks for them first", () => {
  const problems: string[] = []
  for (const file of [...globSync("src/**/*.{mts,tsx}"), "public/sw.js"]) {
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((line, i) => {
      // Comments only mention APIs
      const code = /^\s*(\/\/|\/?\*)/.test(line) ? "" : line.replace(/\s\/\/\s.*$/, "")
      for (const [, receiver, member, check] of code.matchAll(/(?<![\w.$])([A-Za-z]\w*)\??\.([A-Za-z]\w*)(\?\.)?/g)) {
        const compat = !check && compatOf(receiver, member)
        const browsers = compat ? tooOld(compat) : []
        if (browsers.length)
          problems.push(`${file}:${i + 1} ${receiver}.${member} isn't in ${browsers.join(", ")}`)
      }
    })
  }
  expect(problems).toEqual([])
})
