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

/** The words of a search, as uFuzzy splits them */
export const splitTerms = (needle: string) =>
  fuzzy.split(needle)
