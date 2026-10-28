import { afterEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertCleanGitWorkspace } from "../../src/state/workspace-guard"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

async function git(root: string, args: readonly string[]) {
  const process = Bun.spawn(["/usr/bin/git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(process.stderr).text()
  const code = await process.exited
  if (code !== 0) throw new Error(output)
}

describe("extend workspace guard", () => {
  test("accepts a clean repository and rejects untracked changes", async () => {
    const root = await trackedTempDirectory(join(tmpdir(), "app-workspace-"))
    await git(root, ["init", "-q"])
    await git(root, ["config", "user.email", "test@example.invalid"])
    await git(root, ["config", "user.name", "Harness Test"])
    await writeFile(join(root, "README.md"), "clean\n")
    await git(root, ["add", "README.md"])
    await git(root, ["commit", "-qm", "initial"])
    await expect(assertCleanGitWorkspace(root)).resolves.toBeUndefined()
    await writeFile(join(root, "dirty.txt"), "dirty\n")
    await expect(assertCleanGitWorkspace(root)).rejects.toThrow("dirty")
  })

  test("rejects a non-git extend target", async () => {
    const root = await trackedTempDirectory(join(tmpdir(), "app-workspace-none-"))
    await expect(assertCleanGitWorkspace(root)).rejects.toThrow("Git")
  })
})
