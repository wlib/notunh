// The entry for plain pages, which need nothing but the shell and their own simple styles

import "./index.mts"
import "./page.css"
import { watch } from "bruh/reactive"
import { choice, isPrivate } from "./usage.tsx"

// Email addresses are written backward in the page to keep them from harvesters
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-email-backward]"))
  link.href = `mailto:${[...link.dataset.emailBackward!].reverse().join("")}`

// The home page's setting for usage stats, which a browser with Global Privacy Control has made already
const usage = document.querySelector<HTMLInputElement>("input[data-usage]")
if (usage) {
  // Opened when linked to, as the prompt's "Details" is
  if (location.hash === "#usage")
    document.querySelector<HTMLDetailsElement>("details#usage")!.open = true
  usage.disabled = isPrivate
  document.querySelector<HTMLElement>("[data-usage-private]")!.hidden = !isPrivate
  watch([choice], () => {
    usage.checked = !isPrivate && choice.value === "yes"
  })
  usage.addEventListener("change", () => choice.value = usage.checked ? "yes" : "no")
}
