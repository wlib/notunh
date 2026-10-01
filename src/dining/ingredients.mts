// Ingredient statements as trees: "Bread (Flour (Wheat, Niacin), Water)" lists Bread, made of Flour and Water,
// with Flour made of Wheat and Niacin. Labels are written by hand, so this tolerates what they get wrong:
// brackets left open (Nutrislice cuts long ones off), missing commas, and sentences instead of commas

/** A name, or a name and what it's made of */
export type Ingredient = string | [name: string, parts: Ingredient[]]

export const nameOf = (ingredient: Ingredient) =>
  typeof ingredient === "string" ? ingredient : ingredient[0]

export const partsOf = (ingredient: Ingredient) =>
  typeof ingredient === "string" ? [] : ingredient[1]

const OPENERS = "(["
const CLOSERS = ")]"

/** Whether a period at i ends a sentence, rather than abbreviating like "L. bulgaricus" or splitting "0.15" */
const endsSentence = (text: string, i: number) =>
  text[i] === "." &&
  /\s/.test(text[i + 1] ?? " ") &&
  /(\p{L}{3}|[)\]])$/u.test(text.slice(0, i))

// "Contains 2% or less of Salt", "Contains one or more of the following oils - Canola", or "Seasoning: Salt"
const LABEL = /^(contains?\b.*?\bof\b(?: the following(?: \p{L}+)?)?)\s*[:-]?\s*(.*)$|^([^:]*):\s*(.*)$/iu

/**
 * Lists with an item like "Contains 2% or less of: Salt, Yeast" become that label,
 * made of the rest of the list
 */
const groupLabels = (items: Ingredient[]): Ingredient[] => {
  const at = items.findIndex(item => LABEL.test(nameOf(item)))
  if (at === -1)
    return items

  const item = items[at]
  const [, containsLabel, containsFirst, label = containsLabel, first = containsFirst] = nameOf(item).match(LABEL)!
  const firstPart: Ingredient[] =
    first.trim()
      ? [partsOf(item).length ? [first.trim(), partsOf(item)] : first.trim()]
      : partsOf(item)
  return [...items.slice(0, at), [label.trim(), [...firstPart, ...items.slice(at + 1)]]]
}

export const parseIngredients = (text: string): Ingredient[] => {
  // Nutrislice passes along mangled characters as replacement characters
  const source = text.replace(/\uFFFD/g, "").replace(/\s+/g, " ").trim()
  let i = 0

  const list = (isNested: boolean): Ingredient[] => {
    const items: Ingredient[] = []
    let name = ""
    let parts: Ingredient[] | undefined

    const finish = () => {
      const trimmed = name.replace(/^[\s.]+/, "").trim()
      if (trimmed || parts?.length)
        items.push(parts?.length ? [trimmed, parts] : trimmed)
      name = ""
      parts = undefined
    }

    while (i < source.length) {
      const c = source[i]
      if (OPENERS.includes(c)) {
        i++
        parts = [...parts ?? [], ...list(true)]
      }
      else if (CLOSERS.includes(c)) {
        i++
        // A closer with nothing open is a typo
        if (isNested)
          break
      }
      else if (c === "," || c === ";" || endsSentence(source, i)) {
        i++
        finish()
      }
      else {
        // Words after a closing bracket without a comma are the next ingredient
        if (parts && c !== " ")
          finish()
        name += c
        i++
      }
    }
    finish()
    return groupLabels(items)
  }

  return list(false)
}

/** Every name in the tree, depth first, as they're written */
export const flattenIngredients = (ingredients: Ingredient[]): string[] =>
  ingredients.flatMap(ingredient => [nameOf(ingredient), ...flattenIngredients(partsOf(ingredient))])

/** Back to a label's text */
export const formatIngredients = (ingredients: Ingredient[]): string =>
  ingredients
    .map(ingredient =>
      partsOf(ingredient).length
        ? `${nameOf(ingredient)} (${formatIngredients(partsOf(ingredient))})`
        : nameOf(ingredient)
    )
    .join(", ")
