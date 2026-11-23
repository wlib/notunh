// UNH's teams' games as the sheet's Sports page lists them (ui/Sports.tsx), from the games the build keeps in
// events.json (src/social/sources.mts): those played, newest first, each with its result as a line says it, "W 3–1",
// and the few to come; and what search finds of them, a sport by a word of its name, or the page by a word like
// "scores". Results are Athletics' finals, a night old at most; none is said live. Pure

import type { Event, Game, Result } from "../social/event.mts"
import { LINGER } from "../social/event.mts"

/** An event that's one of UNH's teams' games */
export type Played = Event & { game: Game }

const ordinal = new Intl.PluralRules("en-US", { type: "ordinal" })
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" }

/** A result as a row says it: "W 3–1", "L 4–5 OT", or a meet's place, "8th" */
export const scoreOf = (result: Result) =>
  result.outcome === "placed"
    ? `${result.place}${SUFFIX[ordinal.select(result.place)]}`
    : `${result.outcome} ${result.us}–${result.them}${result.extra ? ` ${result.extra}` : ""}`

/** Who a game's against as a line says it, "vs Maine" at home and "at Harvard" away, or a meet's name alone */
export const againstOf = ({ opponent, home }: Game) =>
  opponent ? `${home ? "vs" : "at"} ${opponent}` : ""

/** The games with a result, newest first */
export const results = (games: readonly Event[]): Played[] =>
  games.filter((game): game is Played => game.game?.result !== undefined).sort((a, b) => b.start - a.start)

/** How many games to come the page lists */
export const NEXT = 3

/** The next few games, soonest first: not over, and with no result yet */
export const nextGames = (games: readonly Event[], now: number): Played[] =>
  games
    .filter((game): game is Played => game.game !== undefined && game.game.result === undefined && game.end + LINGER > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, NEXT)

/** What the page's own row is found by, besides a sport's name */
const WORDS = ["scores", "results", "sports", "games", "athletics", "wildcats", "teams"]

/** Text as words, lowercased, without punctuation */
const wordsOf = (text: string) =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * What search finds for what's typed, three letters or more: the results of each sport each of whose words a word of
 * its name starts with ("hockey", "women's ice"), newest first, and whether the page is found, for those or a word
 * like "scores"
 */
export const sportsFor = (typed: string, games: readonly Event[]) => {
  const typedWords = wordsOf(typed)
  if (typedWords.join(" ").length < 3)
    return { isPage: false, played: [] }
  const played = results(games).filter(({ game }) => {
    const words = wordsOf(game.sport)
    return typedWords.every(typed => words.some(word => word.startsWith(typed)))
  })
  return { isPage: played.length > 0 || typedWords.some(typed => WORDS.some(word => word.startsWith(typed))), played }
}
