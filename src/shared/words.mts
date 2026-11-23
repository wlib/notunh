// Finding one of a page's things by the words typed, each the start of one of the thing's own, as the home's search
// finds a phone number by "police disp" and a sport's results by "wom ice", and their page by a word of its own. Pure

/** Text as words, lowercased, without punctuation */
export const wordsOf = (text: string) =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * What's typed finds of some things, three letters or more: those each typed word starts a word of, by each one's
 * text, in their order, and whether their page is found too, for any of them or a word of its own, like "scores".
 * An "and" typed counts for nothing, as it's in half of what's named and starts every "Andrew"
 */
export const foundBy = <T,>(typed: string, things: readonly T[], textOf: (thing: T) => string, pageWords: readonly string[]) => {
  const typedWords = wordsOf(typed).filter(word => word !== "and")
  if (typedWords.join(" ").length < 3)
    return { isPage: false, found: [] }
  const found = things.filter(thing => {
    const words = wordsOf(textOf(thing))
    return typedWords.every(typed => words.some(word => word.startsWith(typed)))
  })
  return { isPage: found.length > 0 || typedWords.some(typed => pageWords.some(word => word.startsWith(typed))), found }
}
