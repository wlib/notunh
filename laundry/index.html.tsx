/** @jsxImportSource bruh/server */
import { MetaDocument } from "bruh/server"
import { Head } from "../src/shell/Head.tsx"

export default () =>
  new MetaDocument(
    <html lang="en-US">
      <Head
        title="Laundry · notunh"
        description="Which washers and dryers are free in every UNH laundry room, and when each room is usually busy"
        script="/src/laundry/index.tsx"
      />
      <body>
        <div id="app" />
      </body>
    </html>
  ).toStringPromise()
