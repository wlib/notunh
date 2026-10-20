// Publish immutable generations before moving their pointer; retries always retry the deploy hook.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

export const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
export const release = (tag: string): { assets: { name: string }[] } | null => {
  // Only a genuine 404 means absent. Authentication/network failures must stop publication.
  const repo = process.env.GH_REPO
  if (!repo) throw new Error("GH_REPO is required")
  try { return JSON.parse(gh("api", `repos/${repo}/releases/tags/${tag}`)) }
  catch (error) {
    if (String((error as { stderr?: unknown }).stderr).includes("HTTP 404")) return null
    throw error
  }
}

export const publish = async (kind: string, folder: string, notes: string, hook = "", command = gh, lookup = release, load = fetch) => {
  const pointer = await readFile(join(folder, "latest.json"), "utf8").then(JSON.parse, error => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (!pointer) { console.log("Nothing new to publish"); return }
  const tag = `${kind}-${pointer.version}`
  const generation = lookup(tag)
  if (!generation?.assets.some(asset => asset.name === "manifest.json")) {
    if (!generation) command("release", "create", tag, "--latest=false", "--title", tag, "--notes", notes)
    command("release", "upload", tag, join(folder, `${kind}.tar.gz`), "--clobber")
    command("release", "upload", tag, join(folder, "manifest.json"), "--clobber")
  }
  if (!lookup(kind)) command("release", "create", kind, "--latest=false", "--title", kind, "--notes", `latest.json names the generation of ${kind} every build takes`)
  command("release", "upload", kind, join(folder, "latest.json"), "--clobber")
  if (hook) {
    const response = await load(hook, { method: "POST" })
    if (!response.ok) throw new Error(`Deploy hook returned ${response.status}`)
  }
}

if (import.meta.main)
  await publish(process.env.KIND!, process.env.FOLDER!, process.env.NOTES!, process.env.DEPLOY_HOOK)
