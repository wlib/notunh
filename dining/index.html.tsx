/** @jsxImportSource bruh/server */
import { readFileSync } from "node:fs"
import { MetaDocument } from "bruh/server"
import * as v from "valibot"
import { Head } from "../src/shell/Head.tsx"
import { AppTitle } from "../src/shell/ui.tsx"
import { PAGES } from "../src/shell/pages.mts"
import { type Meal, MEALS, MenusIndex, fileUrl } from "../src/dining/menus.mts"
import { spansOn } from "../src/dining/hours.mts"
import { localDay } from "../src/shared/time.mts"
import menus from "../src/dining/menus.json" with { type: "json" }

const dated = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })

/** Minutes after a day's midnight as Durham's clock reads them, "7:15 AM" */
const wall = (minutes: number) =>
  clock.format(minutes * 60_000).replace(/[\u202f\u2009]/g, " ")

/**
 * Each hall's menus on the day this is built, which a nightly build makes the day it's served, as text for search
 * engines and the first paint: the hall's hours, and each meal's stations and what they serve. The app replaces it
 */
const Today = ({ day }: { day: string }) => {
  const index = v.parse(MenusIndex, menus)
  const halls = index.halls.flatMap(hall => {
    const served = index.days[hall.id]?.[day]
    const meals = served ? JSON.parse(readFileSync(new URL(`../public${fileUrl(served.file)}`, import.meta.url), "utf8")) as Meal[] : []
    const hours = index.hours[hall.id]
    return meals.length ? [{ hall, hours: hours ? spansOn(hours, day) : [], meals: meals.toSorted((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal)) }] : []
  })
  if (!halls.length)
    return <></>
  return <>
    <h2>Holloway &amp; Philbrook menus for {dated.format(Date.parse(`${day}T12:00:00Z`))}</h2>
    {halls.map(({ hall, hours, meals }) => <>
      <h3>{hall.name}</h3>
      {hours.length > 0 && <p class="muted">Open {hours.map(([open, close]) => `${wall(open)} – ${wall(close % 1440)}`).join(", ")}</p>}
      {meals.map(({ meal, stations }) => <>
        <h4>{meal[0].toUpperCase() + meal.slice(1)}</h4>
        <dl>
          {stations.map(({ name, foods }) => <>
            <dt>{name}</dt>
            <dd>{foods.map(({ name }) => name).join(", ")}</dd>
          </>)}
        </dl>
      </>)}
    </>)}
  </>
}

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        path="/dining/"
        script="/src/dining/index.tsx"
        data={{ menus: "/src/dining/menus.json" }}
      />
      <body>
        {/* What the app replaces once it's loaded: its header, what it does, which names the halls, and today's menus */}
        <div id="app">
          <main class="dining">
            <header>
              <AppTitle page="Dining" />
            </header>
            <section class="shell">
              <p class="muted">{PAGES["/dining/"].description}</p>
              <Today day={localDay(Date.now())} />
            </section>
          </main>
        </div>
      </body>
    </html>
  ).toStringPromise()
