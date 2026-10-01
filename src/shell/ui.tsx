/** @jsxImportSource bruh/browser */

/** The app's name leading home, then the page's own */
export const AppTitle = ({ page }: { page: string }) =>
  <h1 class="app-title">
    <a href="/">notunh</a>
    <span aria-hidden="true">/</span>
    {page}
  </h1>

/** An icon from base.css, like "close" */
export const Icon = ({ name }: { name: string }) =>
  <span class={`icon icon-${name}`} aria-hidden="true" />
