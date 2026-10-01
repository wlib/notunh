// The entry for plain pages, which need nothing but the shell and their own simple styles

import "./index.mts"
import "./page.css"

// Email addresses are written backward in the page to keep them from harvesters
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-email-backward]"))
  link.href = `mailto:${[...link.dataset.emailBackward!].reverse().join("")}`
