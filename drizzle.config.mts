// drizzle-kit writes the migrations wrangler applies, local and remote, from worker/schema.mts

import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./worker/schema.mts",
  out: "./worker/migrations"
})
