// UNH's teams' games as the sheet's Sports page lists them (ui/Sports.tsx), from the games the build keeps in
// events.json (src/social/sources.mts): those played, newest first, each with its result as a line says it, "W 3–1",
// and the few to come; and what search finds of them, a sport by a word of its name, or the page by a word like
// "scores". Results are Athletics' finals, a night old at most; none is said live. Pure

import type { Event, Game, Result } from "../social/event.mts"
import { LINGER } from "../social/event.mts"
import { foundBy } from "../shared/words.mts"

/** An event that's one of UNH's teams' games */
export type GameEvent = Event & { game: Game }

const ordinal = new Intl.PluralRules("en-US", { type: "ordinal" })
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" }

/** A result as a row says it: "W 3–1", "L 4–5 OT", or a meet's place, "8th" */
export const scoreOf = (result: Result) =>
  result.outcome === "placed"
    ? `${result.place}${SUFFIX[ordinal.select(result.place)]}`
    : `${result.outcome} ${result.us}–${result.them}${result.extra ? ` ${result.extra}` : ""}`

/**
 * Who a game's against as a line says it, "vs Maine" at home or at neither's and "at Harvard" away, as Athletics'
 * title does, or nothing where it names nobody
 */
export const againstOf = ({ opponent, home, neutral }: Game) =>
  opponent ? `${home || neutral ? "vs" : "at"} ${opponent}` : ""

/** Where a game is, in a word */
export const sideOf = ({ home, neutral }: Game) =>
  home ? "Home" : neutral ? "Neutral" : "Away"

/** The games with a result, newest first */
export const results = (games: readonly Event[]): GameEvent[] =>
  games.filter((game): game is GameEvent => game.game?.result !== undefined).sort((a, b) => b.start - a.start)

/** How many games to come the page lists */
export const NEXT = 3

/** The next few games, soonest first: not over, and with no result yet */
export const nextGames = (games: readonly Event[], now: number): GameEvent[] =>
  games
    .filter((game): game is GameEvent => game.game !== undefined && game.game.result === undefined && game.end + LINGER > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, NEXT)

/** What the page's own row is found by, besides a sport's name */
const WORDS = ["scores", "results", "sports", "games", "athletics", "wildcats", "teams"]

/**
 * What search finds for what's typed (src/shared/words.mts): the results of each sport the words typed start words
 * of the name of ("hockey", "women's ice"), newest first, and whether the page is found, for those or a word like
 * "scores"
 */
export const sportsFor = (typed: string, games: readonly Event[]) =>
  foundBy(typed, results(games), ({ game }) => game.sport, WORDS)
