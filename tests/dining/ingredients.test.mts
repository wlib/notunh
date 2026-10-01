import { test, expect } from "vitest"
import fc from "fast-check"
import { flattenIngredients, formatIngredients, parseIngredients, type Ingredient } from "../../src/dining/ingredients.mts"

// Words from real labels, none of which start a "Contains … of" clause
const word = fc.constantFrom("Wheat", "Flour", "Niacin", "salt", "Soybean", "Oil", "2%", "Vitamin", "B1", "O'Brien", "Half-and-Half", "&")
const name = fc.array(word, { minLength: 1, maxLength: 4 }).map(words => words.join(" "))

const { tree } = fc.letrec<{ tree: Ingredient[], ingredient: Ingredient }>(tie => ({
  tree: fc.array(tie("ingredient"), { minLength: 1, maxLength: 4 }),
  ingredient: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    name,
    fc.tuple(name, tie("tree"))
  )
}))

test("a label written out from a tree parses back to it", () =>
  fc.assert(fc.property(tree, ingredients => {
    expect(parseIngredients(formatIngredients(ingredients))).toEqual(ingredients)
  }))
)

const alphanumerics = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "")

test("parsing anything never loses or reorders a letter or digit, however mangled the brackets", () =>
  fc.assert(fc.property(
    fc.array(fc.oneof(word, fc.constantFrom(", ", "; ", " (", ") ", "[", "]", ". ", ": ", "Contains 2% or less of ", " ")), { maxLength: 40 }),
    pieces => {
      const text = pieces.join("")
      expect(alphanumerics(flattenIngredients(parseIngredients(text)).join(""))).toBe(alphanumerics(text))
    }
  ))
)

test("parsing never throws on any text", () =>
  fc.assert(fc.property(fc.string({ unit: "grapheme" }), text => {
    parseIngredients(text)
  }))
)

test("real label shapes", () => {
  expect(parseIngredients("Bread (Flour [Wheat, Niacin], Water. Contains 2% or less of Salt, Yeast)")).toEqual([
    ["Bread", [["Flour", ["Wheat", "Niacin"]], "Water", ["Contains 2% or less of", ["Salt", "Yeast"]]]]
  ])
  expect(parseIngredients("Oil (Contains one or more of the following oils - Canola, Corn), Salt")).toEqual([
    ["Oil", [["Contains one or more of the following oils", ["Canola", "Corn"]]]], "Salt"
  ])
  // Cut off partway, as Nutrislice does to long labels
  expect(parseIngredients("Yogurt (milk, cultures (L. bulgaricus, S. thermophilus")).toEqual([
    ["Yogurt", ["milk", ["cultures", ["L. bulgaricus", "S. thermophilus"]]]]
  ])
})
