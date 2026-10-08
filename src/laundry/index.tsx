/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r } from "bruh/reactive"
import { openRoom } from "./state.mts"
import { AppTitle } from "../shell/ui.tsx"
import { RoomList } from "./ui/RoomList.tsx"
import { RoomView } from "./ui/RoomView.tsx"

const App = () =>
  <main class="laundry">
    <header>
      <AppTitle page="Laundry" />
    </header>
    {r(() => openRoom.value ? <RoomView id={openRoom.value} /> : <RoomList />)}
  </main>

document.getElementById("app")!.replaceChildren(<App />)
