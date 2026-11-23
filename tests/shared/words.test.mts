import { test, expect } from "vitest"
import fc from "fast-check"
import { foundBy, wordsOf } from "../../src/shared/words.mts"

const aWord = fc.stringMatching(/^[a-z]{3,8}$/).filter(word => word !== "and")
const aName = fc.array(aWord, { minLength: 1, maxLength: 4 }).map(words => words.join(" "))
const names = fc.uniqueArray(aName, { minLength: 1, maxLength: 8 })
const same = (name: string) => name

test("text reads as its words, lowercased, without punctuation", () => {
  expect(wordsOf("Women's Ice Hockey")).toEqual(["women", "s", "ice", "hockey"])
  expect(wordsOf("  Health & Wellness, 24/7 ")).toEqual(["health", "wellness", "24", "7"])
  expect(wordsOf("")).toEqual([])
})

test("a thing is found by the start of any of its words, in any case, with the page", () =>
  fc.assert(fc.property(names, fc.nat(), fc.nat(), fc.integer({ min: 3, max: 8 }), fc.boolean(), (all, i, j, length, isUpper) => {
    const name = all[i % all.length]
    const words = name.split(" ")
    const typed = words[j % words.length].slice(0, length)
    const { isPage, found } = foundBy(isUpper ? typed.toUpperCase() : typed, all, same, [])
    expect(found).toContain(name)
    expect(isPage).toBe(true)
  }))
)

test("whatever's typed, what's found is some of the things, in their order, each typed word starting one of its own", () =>
  fc.assert(fc.property(names, fc.oneof(fc.string(), aName), (all, typed) => {
    const { isPage, found } = foundBy(typed, all, same, [])
    expect(all.filter(name => found.includes(name))).toEqual(found)
    const typedWords = wordsOf(typed).filter(word => word !== "and")
    for (const name of found)
      expect(typedWords.every(word => name.split(" ").some(own => own.startsWith(word)))).toBe(true)
    expect(isPage).toBe(found.length > 0)
  }))
)

test("the page is found by the start of a word of its own, with none of its things", () => {
  expect(foundBy("sco", ["hockey"], same, ["scores"])).toEqual({ isPage: true, found: [] })
  expect(foundBy("all the scores", ["hockey"], same, ["scores"])).toEqual({ isPage: true, found: [] })
  expect(foundBy("score", ["hockey"], same, [])).toEqual({ isPage: false, found: [] })
})

test("fewer than three letters find nothing, nor does an and, which a name with one is still found through", () => {
  expect(foundBy("ho", ["hockey"], same, ["hockey"])).toEqual({ isPage: false, found: [] })
  expect(foundBy("and", ["track and field", "anderson"], same, ["and"])).toEqual({ isPage: false, found: [] })
  expect(foundBy("Track and Field", ["track and field", "field hockey"], same, []).found).toEqual(["track and field"])
})
