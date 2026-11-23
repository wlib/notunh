/** @jsxImportSource bruh/browser */

// UNH's teams' scores (../sports.mts), a page of the sheet from Campus: the next few games, then every result the build
// kept, newest first, a day at a time, each row the sport, who against, home or away, and how it ended, opening the
// game's page; a game's page says its final score (FinalScore); search's rows for a sport's results; and Campus's line,
// the latest result. All of it is from the events.json the page was built with, so it's there offline

import { type DerivativeNode, r } from "bruh/reactive"
import type { Result } from "../../social/event.mts"
import { groupBy } from "../../shared/group.mts"
import { daysBetween, localDay } from "../../shared/time.mts"
import { ClockTime, Day, relativeDay } from "../../shell/intl.tsx"
import { type GameEvent, againstOf, nextGames, results, scoreOf, sideOf, sportsFor } from "../sports.mts"
import { state } from "../state/map.mts"
import { nowMs } from "./common.tsx"
import { Group } from "./Courses.tsx"
import { DayName, Head, Row } from "./Pages.tsx"

/** A result as a row says it, a win in green: "W 3–1", or a meet's "8th", "8th place" where it's said alone */
export const Score = ({ result, alone }: { result: Result, alone?: boolean }) =>
  <span class={`score score-${result.outcome}`}>{scoreOf(result)}{alone && result.outcome === "placed" && " place"}</span>

/** Who a game's against, and where: "vs Maine · Home" */
const AgainstOf = ({ game }: { game: GameEvent["game"] }) =>
  <>{againstOf(game)}{againstOf(game) && " · "}{sideOf(game)}</>

/** A game played, as a row: the sport, who against and where, and how it ended, which opens the game's page */
const ResultRow = ({ game }: { game: GameEvent }) =>
  <Row
    class="score-row"
    what={game.game.sport}
    sub={<AgainstOf game={game.game} />}
    standing={game.game.result && <Score result={game.game.result} />}
    onclick={() => state.go({ kind: "event", id: game.id })}
  />

/** A game to come, as a row: when, the sport, and who against and where */
const NextRow = ({ game }: { game: GameEvent }) =>
  <Row
    time={<><DayName day={localDay(game.start)} /><small><ClockTime at={new Date(game.start)} /></small></>}
    what={game.game.sport}
    sub={<AgainstOf game={game.game} />}
    onclick={() => state.go({ kind: "event", id: game.id })}
  />

/** A day results were on as its heading says it: "Today", "Yesterday", or "Sat, Nov 21" */
const DayHeading = ({ day }: { day: string }) => {
  const ago = daysBetween(day, localDay(nowMs()))
  return ago >= 0 && ago < 2 ? <>{relativeDay(-ago)}</> : <Day of={day} weekday="short" month="short" day="numeric" />
}

/** The scores in the sheet: the next few games, then each day's results, newest first */
export const SportsView = () => {
  state.focusAt({ kind: "sports" }, undefined)
  return r(() => {
    const { games } = state.events.value
    const next = nextGames(games, nowMs())
    const days = groupBy(results(games), game => localDay(game.start))
    return <>
      <Head kind="Campus" title="Sports" />
      {next.length > 0 && <>
        <h2 class="eyebrow">Next</h2>
        <ul class="rows">{next.map(game => <NextRow game={game} />)}</ul>
      </>}
      {days.size
        ? [...days].map(([day, played]) => <>
          <h2 class="eyebrow"><DayHeading day={day} /></h2>
          <ul class="rows" data-day={day}>{played.map(game => <ResultRow game={game} />)}</ul>
        </>)
        : <p class="muted">No results yet.</p>}
      <p class="view-foot muted">Final scores from <a href="https://unhwildcats.com" target="_blank" rel="noopener">UNH Athletics</a>, updated nightly.</p>
    </>
  })
}

/** A game's final score, on its page, in the type of its time: "W 3–1 · Final", or a meet's "8th place · Final" */
export const FinalScore = ({ result }: { result: Result }) =>
  <p class="view-when"><Score result={result} alone /> · Final</p>

/** Campus's line: the latest result, "W 3–1 vs Maine · Women's Ice Hockey", or "8th place at America East Championship · Women's Cross Country" */
export const SportsFact = () =>
  r(() => {
    const [latest] = results(state.events.value.games)
    return latest?.game.result
      ? <><Score result={latest.game.result} alone />{againstOf(latest.game) && ` ${againstOf(latest.game)}`} · {latest.game.sport}</>
      : "Scores across UNH's teams"
  })

/** Search's results of a sport for what's typed, the newest first, and the page of them all */
export const SportResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const { isPage, found } = sportsFor(query.value, state.events.value.games)
    return isPage &&
      <Group label="Sports">
        {found.slice(0, 3).map(game => <ResultRow game={game} />)}
        <Row what="All scores" standing="›" onclick={() => state.go({ kind: "sports" })} />
      </Group>
  })
