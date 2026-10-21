// The secrets production's Worker and its GitHub environment share, kept the same on both sides:
//
//   node scripts/secrets.mts check    which are set where, whether .dev.vars' BUILD_TOKEN is production's, and
//                                     whether .dev.vars has push keys of its own
//   node scripts/secrets.mts rotate   a new BUILD_TOKEN for the Worker, the production environment, and .dev.vars
//   node scripts/secrets.mts vapid    push keys for reminders (worker/push.mts) where they're missing: a pair for the
//                                     Worker, and another for .dev.vars
//
// BUILD_TOKEN is on both sides, so it's only ever set by rotate. The Worker's GITHUB_TOKEN, a fine-grained token with
// Actions read and write on this repository, and the environment's CLOUDFLARE_DEPLOY_HOOK, the URL Workers Builds
// gives a deploy hook of main once, as it's made, are each on one side, so check only says if they're missing. The
// Worker's push keys are made once and never replaced, as a new pair orphans every device subscribed with the old,
// so vapid leaves a pair that's there alone and the private key is never shown or kept anywhere else. Needs wrangler
// and gh signed in

import { readFile, writeFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { REPO, run } from "./files.mts"
import { ORIGIN } from "./site.mts"

const ENVIRONMENT = "production"
const VAPID       = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]
const WORKER      = ["BUILD_TOKEN", "GITHUB_TOKEN", ...VAPID]
const GITHUB      = ["BUILD_TOKEN", "CLOUDFLARE_DEPLOY_HOOK"]
const DEV_VARS    = new URL(".dev.vars", REPO)

const workerSecrets = async () =>
  (JSON.parse(await run("npx", ["wrangler", "secret", "list", "--format", "json"], { capture: true })) as { name: string }[])
    .map(({ name }) => name)

const githubSecrets = async () =>
  (JSON.parse(await run("gh", ["secret", "list", "--env", ENVIRONMENT, "--json", "name"], { capture: true })) as { name: string }[])
    .map(({ name }) => name)

const devVars = () =>
  readFile(DEV_VARS, "utf8").catch(() => "")

/** A variable of .dev.vars, which is dotenv's format, if it has it */
const localVar = async (name: string) =>
  parseEnv(await devVars())[name]

/** Sets variables in .dev.vars, in place of any there */
const setLocalVars = async (vars: Record<string, string>) => {
  let text = await devVars()
  for (const [name, value] of Object.entries(vars)) {
    const line = new RegExp(`^${name}=.*$`, "m")
    text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.replace(/(?<=[^\n])$/, "\n")}${name}=${value}\n`
  }
  await writeFile(DEV_VARS, text)
}

/** A VAPID key pair, as the Worker reads it: the public key raw and the private key's scalar, both base64url */
const vapidPair = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return {
    VAPID_PUBLIC_KEY:  Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"),
    VAPID_PRIVATE_KEY: d!
  }
}

/** Whether production's Worker takes a token, by a route that needs one */
const isProductions = async (token: string) =>
  (await fetch(`${ORIGIN}/api/models/buses`, { headers: { authorization: `Bearer ${token}` } })).ok

const check = async () => {
  const [worker, github, token, local] = await Promise.all([workerSecrets(), githubSecrets(), localVar("BUILD_TOKEN"), Promise.all(VAPID.map(localVar))])
  const missing = [
    ...WORKER.filter(name => !worker.includes(name)).map(name => `the Worker's ${name}`),
    ...GITHUB.filter(name => !github.includes(name)).map(name => `the ${ENVIRONMENT} environment's ${name}`)
  ]
  for (const name of missing)
    console.warn(`Missing ${name}`)
  const isProduction = token && await isProductions(token)
  console.log(`.dev.vars' BUILD_TOKEN ${isProduction ? "is" : "isn't"} production's`)
  const hasPushKeys = local.every(Boolean)
  console.log(`.dev.vars ${hasPushKeys ? "has" : "hasn't"} push keys`)
  if (missing.length || !isProduction || !hasPushKeys)
    process.exitCode = 1
}

const rotate = async () => {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
  await run("npx", ["wrangler", "secret", "put", "BUILD_TOKEN"], { input: new Response(token) })
  await run("gh", ["secret", "set", "BUILD_TOKEN", "--env", ENVIRONMENT], { input: new Response(token) })
  await setLocalVars({ BUILD_TOKEN: token })
  if (!await isProductions(token))
    throw new Error("The Worker doesn't take the new BUILD_TOKEN yet")
  console.log("Rotated BUILD_TOKEN in the Worker, the production environment, and .dev.vars")
}

const vapid = async () => {
  const worker = await workerSecrets()
  if (VAPID.every(name => worker.includes(name)))
    console.log("The Worker has push keys already, which are kept")
  else {
    // Both at once, so the Worker never has half a pair, and through stdin, so the private key is never shown
    await run("npx", ["wrangler", "secret", "bulk"], { input: new Response(JSON.stringify(await vapidPair())) })
    console.log("Gave the Worker push keys")
  }
  if ((await Promise.all(VAPID.map(localVar))).every(Boolean))
    console.log(".dev.vars has push keys already, which are kept")
  else {
    await setLocalVars(await vapidPair())
    console.log("Gave .dev.vars push keys of its own")
  }
}

const command = process.argv[2]
if (command === "check")
  await check()
else if (command === "rotate")
  await rotate()
else if (command === "vapid")
  await vapid()
else
  throw new Error("Usage: node scripts/secrets.mts check | rotate | vapid")
