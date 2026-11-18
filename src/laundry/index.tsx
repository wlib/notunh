/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r } from "bruh/reactive"
import { isFromList, isUnknownRoom, openRoom } from "./state.mts"
import { AppTitle, PageHead } from "../shell/ui.tsx"
import { RoomList } from "./ui/RoomList.tsx"
import { RoomView } from "./ui/RoomView.tsx"

/**
 * The page's head, with its one way back: to the list, where the room open was opened from it, else to the map, as
 * every page of its own has (PageHead)
 */
const Head = () =>
  r(() => openRoom.value && isFromList.value
    ? <header class="page-head">
        <a class="back" href="/laundry/" onclick={(event: MouseEvent) => { event.preventDefault(); history.back() }}><span aria-hidden="true">‹</span> All rooms</a>
        <AppTitle page="Laundry" />
      </header>
    : <PageHead page="Laundry" sheet="/map/laundry" />)

const App = () =>
  <main class="laundry">
    <Head />
    {r(() =>
      isUnknownRoom.value ? <p class="empty muted">There's no such room. <a href="/laundry/">All rooms</a></p> :
      openRoom.value      ? <RoomView id={openRoom.value} /> :
                            <RoomList />
    )}
  </main>

document.getElementById("app")!.replaceChildren(<App />)
