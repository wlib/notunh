/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        title="Dining · notunh"
        description="What UNH's dining halls are serving at every meal, with ingredients, allergens, and nutrition"
        script="/src/dining/index.tsx"
      />
      <body>
        <div id="app" />
      </body>
    </html>
  ).toStringPromise()
