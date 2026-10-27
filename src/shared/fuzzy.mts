// Fuzzy search with uFuzzy, as the dining page searches foods and the map places: a typo forgiven per word
// ("chikpea"), words matched in any order, and words prefixed with "-" left out ("pasta -cheese")

import uFuzzy from "@leeoniya/ufuzzy"

const fuzzy = new uFuzzy({
  // A single error per word
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1
})

// Words permuted to match out of order, past which a search just has them in order
const OUT_OF_ORDER = 3

/** Text as searched, without accents */
export const { latinize } = uFuzzy

/**
 * What in a haystack matches a needle, best first, with the ranges matched, except when there are too many matches
 * for uFuzzy to rank, when they're in the haystack's order without ranges
 */
export const fuzzySearch = (haystack: string[], needle: string) => {
  const [idxs, info, order] = fuzzy.search(haystack, needle, OUT_OF_ORDER)
  return order
    ? order.map(i => ({ index: info.idx[i], ranges: info.ranges[i] as number[] | undefined }))
    : (idxs ?? []).map(index => ({ index, ranges: undefined }))
}

// The Greek alphabet's letters by name, as English spells them, for the letters of a fraternity or sorority, "ΣΦΕ"
const GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega"]
// Their capitals from Α at U+0391, skipping U+03A2, where the small letters have their final sigma
const LETTER = new Map(GREEK.flatMap((name, i) => {
  const capital = String.fromCodePoint(0x391 + i + (i >= 17 ? 1 : 0))
  return [[capital, name], [capital.toLowerCase(), name]]
}))
LETTER.set("ς", "Sigma")

/** Text with each Greek letter spelled out as a word of its own, as searched: "ΣΦΕ" as "Sigma Phi Epsilon" */
export const spellGreek = (text: string) =>
  text.replace(/\p{Script=Greek}/gu, letter => LETTER.has(letter) ? ` ${LETTER.get(letter)} ` : letter).replace(/\s+/g, " ").trim()

/** The words of a search, as uFuzzy splits them */
export const splitTerms = (needle: string) =>
  fuzzy.split(needle)
