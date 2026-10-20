// The secrets production's Worker and its GitHub environment share, kept the same on both sides:
//
//   node scripts/secrets.mts check    which are set where, and whether .dev.vars' BUILD_TOKEN is production's
//   node scripts/secrets.mts rotate   a new BUILD_TOKEN for the Worker, the production environment, and .dev.vars
//
// BUILD_TOKEN is on both sides, so it's only ever set by rotate. The Worker's GITHUB_TOKEN, a fine-grained token with
// Actions read and write on this repository, and the environment's CLOUDFLARE_DEPLOY_HOOK, the URL Workers Builds
// gives a deploy hook of main once, as it's made, are each on one side, so check only says if they're missing. Needs
// wrangler and gh signed in

import { readFile, writeFile } from "node:fs/promises"
import { REPO, run } from "./files.mts"
import { ORIGIN } from "./site.mts"

const ENVIRONMENT = "production"
const WORKER      = ["BUILD_TOKEN", "GITHUB_TOKEN"]
const GITHUB      = ["BUILD_TOKEN", "CLOUDFLARE_DEPLOY_HOOK"]
const DEV_VARS    = new URL(".dev.vars", REPO)

const workerSecrets = async () =>
  (JSON.parse(await run("npx", ["wrangler", "secret", "list", "--format", "json"], { capture: true })) as { name: string }[])
    .map(({ name }) => name)

const githubSecrets = async () =>
  (JSON.parse(await run("gh", ["secret", "list", "--env", ENVIRONMENT, "--json", "name"], { capture: true })) as { name: string }[])
    .map(({ name }) => name)

/** .dev.vars' BUILD_TOKEN, if it has one */
const localToken = async () =>
  (await readFile(DEV_VARS, "utf8").catch(() => "")).match(/^BUILD_TOKEN=(.*)$/m)?.[1]

/** Whether production's Worker takes a token, by a route that needs one */
const isProductions = async (token: string) =>
  (await fetch(`${ORIGIN}/api/models/buses`, { headers: { authorization: `Bearer ${token}` } })).ok

const check = async () => {
  const [worker, github, token] = await Promise.all([workerSecrets(), githubSecrets(), localToken()])
  const missing = [
    ...WORKER.filter(name => !worker.includes(name)).map(name => `the Worker's ${name}`),
    ...GITHUB.filter(name => !github.includes(name)).map(name => `the ${ENVIRONMENT} environment's ${name}`)
  ]
  for (const name of missing)
    console.warn(`Missing ${name}`)
  const local = token && await isProductions(token)
  console.log(`.dev.vars' BUILD_TOKEN ${local ? "is" : "isn't"} production's`)
  if (missing.length || !local)
    process.exitCode = 1
}

const rotate = async () => {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
  await run("npx", ["wrangler", "secret", "put", "BUILD_TOKEN"], { input: new Response(token) })
  await run("gh", ["secret", "set", "BUILD_TOKEN", "--env", ENVIRONMENT], { input: new Response(token) })
  const vars = await readFile(DEV_VARS, "utf8").catch(() => "")
  await writeFile(DEV_VARS, /^BUILD_TOKEN=/m.test(vars) ? vars.replace(/^BUILD_TOKEN=.*$/m, `BUILD_TOKEN=${token}`) : `${vars}BUILD_TOKEN=${token}\n`)
  if (!await isProductions(token))
    throw new Error("The Worker doesn't take the new BUILD_TOKEN yet")
  console.log("Rotated BUILD_TOKEN in the Worker, the production environment, and .dev.vars")
}

const command = process.argv[2]
if (command === "check")
  await check()
else if (command === "rotate")
  await rotate()
else
  throw new Error("Usage: node scripts/secrets.mts check | rotate")
