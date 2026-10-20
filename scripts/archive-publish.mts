// Every subprocess is checked, including day enumeration, before the catalog can advance.
import { execFileSync } from "node:child_process"
import { mkdir, readdir, copyFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { gh, release } from "./publish.mts"

const archive = (...args: string[]) => execFileSync(process.execPath, ["scripts/archive.mts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim()
export const publishArchives = async (runArchive = archive, command = gh, lookup = release) => {
  const days = runArchive("days", ...[process.env.FROM, process.env.TO].filter((value): value is string => Boolean(value))).split(/\s+/).filter(Boolean)
  await rm("archive", { recursive: true, force: true })
  await mkdir("archive", { recursive: true })
  for (const day of days) {
    const tag = `observations-${day}`
    const existing = lookup(tag)
    if (existing?.assets.some(asset => asset.name === "manifest.json")) {
      command("release", "download", tag, "-p", "manifest.json", "-O", `archive/${day}.json`, "--clobber")
      continue
    }
    const folder = `archive/${day}`
    console.log(runArchive("pack", day, folder))
    if (!(await readdir(folder).catch((): string[] => [])).includes("manifest.json")) continue
    if (!existing) command("release", "create", tag, "--latest=false", "--title", `Observations ${day}`, "--notes", `Worker observations for service day ${day}, with hashes and counts in manifest.json`)
    command("release", "upload", tag, join(folder, `observations-${day}.ndjson.zst`), "--clobber")
    command("release", "upload", tag, join(folder, "manifest.json"), "--clobber")
    await copyFile(join(folder, "manifest.json"), `archive/${day}.json`)
  }
  const manifests = (await readdir("archive")).filter(name => name.endsWith(".json") && name !== "catalog.json").map(name => join("archive", name))
  if (manifests.length) {
    const existing = lookup("observations")
    if (existing) command("release", "download", "observations", "-p", "catalog.json", "-O", "catalog.json", "--clobber")
    else await writeFile("catalog.json", '{"days":[]}')
    await writeFile("archive/catalog.json", runArchive("catalog", "catalog.json", ...manifests))
    if (!existing) command("release", "create", "observations", "--latest=false", "--title", "Observations", "--notes", "catalog.json lists every archived service day")
    command("release", "upload", "observations", "archive/catalog.json", "--clobber")
  }

}

if (import.meta.main) await publishArchives()
