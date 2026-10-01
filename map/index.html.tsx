/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        title="Map · notunh"
        description="Live UNH Wildcat Transit buses, and directions by bus or on foot"
        script="/src/map/index.tsx"
      />
      <body>
        <div id="app" />
      </body>
    </html>
  ).toStringPromise()
