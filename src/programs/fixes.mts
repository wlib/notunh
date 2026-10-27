// The catalog's prerequisite sentences Banner wrote ambiguously, its brackets unbalanced or "and" mixed with "or"
// unbracketed, each with the tree read by hand, written as the Needs line writes it. A fix holds only while the
// catalog still says exactly what was fixed (catalog.mts), so a corrected or changed sentence is read afresh

export const FIXES: Record<string, { from: string, to: string }> = {
  // Biology first, then a year of organic chemistry: either half of each of its two semesters
  "BMCB 658": {
    from: "(BIOL 411 with a minimum grade of D- or BIOL 411H with a minimum grade of D- or BIOL 413 with a minimum grade of D- or BMS 507 with a minimum grade of D- and ((CHEM 545 with a minimum grade of D- or CHEM 547 with a minimum grade of D- or CHEM 651 with a minimum grade of D- and (CHEM 546 with a minimum grade of D- or CHEM 548 with a minimum grade of D- or CHEM 652 with a minimum grade of D- )",
    to:   "(one of BIOL 411, 411H, 413, BMS 507) and (one of CHEM 545, 547, 651) and (one of CHEM 546, 548, 652)"
  },
  // Biology first, then general chemistry: its two semesters, the honors second, or the one-semester course
  "BMS 503": {
    from: "(BIOL 411 with a minimum grade of D- or BIOL 411H with a minimum grade of D- or BMS 507 with a minimum grade of D- or BIOL 413 with a minimum grade of D- and (( (CHEM 403 with a minimum grade of D- and (CHEM 404 with a minimum grade of D- ) or (CHEM 404H with a minimum grade of D- or CHEM 405 with a minimum grade of D- )",
    to:   "(one of BIOL 411, 411H, BMS 507, BIOL 413) and (one of (CHEM 403 and 404), CHEM 404H, 405)"
  },
  // Either route through BMS, then genetics
  "BMS 740": {
    from: "(BMS 501 with a minimum grade of D- or (BMS 503 with a minimum grade of D- and BMS 504 with a minimum grade of D-) and GEN 604 with a minimum grade of D-)",
    to:   "(BMS 501 or (BMS 503 and 504)) and GEN 604"
  },
  "CHEM 652": {
    from: "(CHEM 651 with a minimum grade of D- and (CHEM 653 with a minimum grade of D-",
    to:   "CHEM 651 and 653"
  },
  "FREN 651": {
    from: "(FREN 631 (may be taken concurrently) with a minimum grade of D- and (FREN 632 (may be taken concurrently) with a minimum grade of D-",
    to:   "FREN 631 (or concurrently) and 632 (or concurrently)"
  },
  // General chemistry's two semesters as one alternative to CHEM 411
  "NUTR 550": {
    from: "NUTR 400 with a minimum grade of D- and NUTR 403 with a minimum grade of D- and (CHEM 411 with a minimum grade of D- or CHEM 403 with a minimum grade of D- and CHEM 404 with a minimum grade of D-)",
    to:   "all of NUTR 400, 403, (CHEM 411 or (CHEM 403 and 404))"
  },
  // Either year of physiology, then BMCB 658
  "NUTR 750": {
    from: "(BMS 507 with a minimum grade of D- and BMS 508 with a minimum grade of D-) or (ANSC 511 with a minimum grade of D- and ANSC 512 with a minimum grade of D-) and BMCB 658 with a minimum grade of D-",
    to:   "((BMS 507 and 508) or (ANSC 511 and 512)) and BMCB 658"
  }
}
