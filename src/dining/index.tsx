/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r } from "bruh/reactive"
import { index, isSearching } from "./state.mts"
import { AppTitle } from "../shell/ui.tsx"
import { DayTime } from "../shell/intl.tsx"
import { Controls } from "./ui/Controls.tsx"
import { MenuView, SearchView } from "./ui/views.tsx"

const App = () =>
  <main class="dining">
    <header>
      <AppTitle page="Dining" />
    </header>
    <Controls />
    {r(() => isSearching.value ? <SearchView /> : <MenuView />)}
    <footer class="muted">
      Menus come from UNH Dining and were last updated <DayTime at={new Date(index.fetched)} />.
      The diet and allergen tags are theirs, so if you have a serious allergy, check with the dining staff too.
    </footer>
  </main>

document.getElementById("app")!.replaceChildren(<App />)
