import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const OMIT = new Set([
  ".next",
  ".cache",
  "artifacts",
  ".git",
  ".app-harness",
  "node_modules",
  "dist",
  ".build",
  "coverage",
  "test-results",
])

async function files(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    if (OMIT.has(entry.name)) continue
    const path = join(prefix, entry.name)
    result.push(...(entry.isDirectory() ? await files(root, path) : [path]))
    if (result.length > 20000) throw new Error("workspace digest exceeds file limit")
  }
  return result
}

export async function workspaceDigest(root: string): Promise<string> {
  let paths: string[]
  try {
    await lstat(join(root, ".git"))
    const { stdout } = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    paths = stdout
      .split("\0")
      .filter((path) => path && !path.split("/").some((part) => OMIT.has(part)))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    paths = await files(root)
  }
  const hash = createHash("sha256")
  for (const path of [...new Set(paths)].sort()) {
    if (path.endsWith(".log")) continue
    hash.update(`${path}\0`)
    try {
      const state = await lstat(join(root, path))
      if (state.isSymbolicLink()) hash.update(await readlink(join(root, path)))
      else if (state.isFile()) {
        if (state.size > 64 * 1024 * 1024) throw new Error("workspace digest file exceeds limit")
        hash.update(String(state.mode & 0o777)).update(await readFile(join(root, path)))
      } else hash.update("directory")
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      hash.update("deleted")
    }
    hash.update("\0")
  }
  return hash.digest("hex")
}
