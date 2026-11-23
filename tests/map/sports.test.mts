import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import type { Event, Game, Result } from "../../src/social/event.mts"
import { LINGER } from "../../src/social/event.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { gamesOf } from "../../src/social/sources.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { NEXT, againstOf, nextGames, results, scoreOf, sideOf, sportsFor } from "../../src/map/sports.mts"

const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const games = gamesOf(await readFile(new URL("../fixtures/events/athletics.ics", import.meta.url), "utf8"), placeMatcher(gazetteer.places.map(place => place.name)))

const aResult: fc.Arbitrary<Result> = fc.oneof(
  fc.record({ outcome: fc.constantFrom("W" as const, "L" as const, "T" as const), us: fc.nat({ max: 200 }), them: fc.nat({ max: 200 }), extra: fc.constantFrom("OT", "2OT", "SO") }, { requiredKeys: ["outcome", "us", "them"] }),
  fc.record({ outcome: fc.constant("placed" as const), place: fc.integer({ min: 1, max: 400 }) })
)
const aGame: fc.Arbitrary<Event> = fc.record({
  id:     fc.uuid(),
  start:  fc.integer({ min: 1.7e12, max: 1.9e12 }),
  length: fc.integer({ min: 0, max: 4 * 3_600_000 }),
  sport:  fc.constantFrom("Football", "Women's Ice Hockey", "Men's Ice Hockey", "Field Hockey"),
  home:   fc.boolean(),
  result: fc.option(aResult, { nil: undefined })
}).map(({ id, start, length, sport, home, result }) => ({
  id, title: sport, start, end: start + length, where: "", source: "athletics", url: "https://unhwildcats.com",
  game: { sport, opponent: "Maine", home, ...result && { result } }
}))

test("a result reads as a row says it: the outcome and the score with an en dash, or a meet's place", () => {
  expect(scoreOf({ outcome: "W", us: 3, them: 1 })).toBe("W 3–1")
  expect(scoreOf({ outcome: "L", us: 4, them: 5, extra: "OT" })).toBe("L 4–5 OT")
  expect(scoreOf({ outcome: "T", us: 0, them: 0 })).toBe("T 0–0")
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 112].map(place => scoreOf({ outcome: "placed", place })))
    .toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "112th"])
})

test("who a game's against says vs at home or at neither's and at away, and nothing for none", () => {
  const game: Game = { sport: "Football", opponent: "Maine", home: true }
  expect(againstOf(game)).toBe("vs Maine")
  expect(againstOf({ ...game, home: false })).toBe("at Maine")
  expect(againstOf({ ...game, opponent: "" })).toBe("")
  // At neither's, as a tournament's game is, Athletics says vs
  expect(againstOf({ ...game, home: false, neutral: true })).toBe("vs Maine")
  expect([game, { ...game, home: false }, { ...game, home: false, neutral: true }].map(sideOf)).toEqual(["Home", "Away", "Neutral"])
})

test("results are every game with one, newest first; the next games are those still to come without one, soonest first", () =>
  fc.assert(fc.property(fc.array(aGame, { maxLength: 30 }), fc.integer({ min: 1.7e12, max: 1.9e12 }), (games, now) => {
    const played = results(games)
    expect(played.length).toBe(games.filter(game => game.game?.result).length)
    expect(played.map(game => game.start)).toEqual(played.map(game => game.start).sort((a, b) => b - a))
    const next = nextGames(games, now)
    expect(next.length).toBe(Math.min(NEXT, games.filter(game => !game.game?.result && game.end + LINGER > now).length))
    expect(next.every(game => !game.game.result && game.end + LINGER > now)).toBe(true)
    expect(next.map(game => game.start)).toEqual(next.map(game => game.start).sort((a, b) => a - b))
  }))
)

test("search finds a sport's results by the start of any word of its name, and the page for those or a word like scores", () => {
  const hockey = sportsFor("hockey", games)
  expect(hockey.isPage).toBe(true)
  expect(new Set(hockey.found.map(({ game }) => game.sport))).toEqual(new Set(["Women's Ice Hockey", "Field Hockey"]))
  expect(sportsFor("women's ice", games).found.every(({ game }) => game.sport === "Women's Ice Hockey")).toBe(true)
  expect(sportsFor("FOOT", games).found.map(({ game }) => game.result)).toEqual([{ outcome: "W", us: 30, them: 23 }, { outcome: "L", us: 13, them: 20 }])
  expect(sportsFor("scores", games)).toEqual({ isPage: true, found: [] })
  expect(sportsFor("game", games).isPage).toBe(true)
  expect(sportsFor("ab", games)).toEqual({ isPage: false, found: [] })
  expect(sportsFor("kingsbury", games)).toEqual({ isPage: false, found: [] })
})

test("whatever's typed, search finds only games with a result, newest first", () =>
  fc.assert(fc.property(fc.array(aGame, { maxLength: 30 }), fc.oneof(fc.string(), fc.constantFrom("hockey", "ice", "foot", "field")), (games, typed) => {
    const { found } = sportsFor(typed, games)
    expect(found.every(({ game }) => game.result !== undefined)).toBe(true)
    expect(found.map(game => game.start)).toEqual(found.map(game => game.start).sort((a, b) => b - a))
  }))
)
