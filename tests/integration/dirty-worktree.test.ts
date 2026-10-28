import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"
import { promisify } from "node:util"

import { captureDirtyWorktree } from "../../src/execution/dirty-worktree"
import { createTempDirectoryTracker } from "../support/temp-directory"

const execFileAsync = promisify(execFile)
const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

test("missing dirty-path restore refuses an intermediate symlink escape", async () => {
  const root = await trackedTempDirectory(join(tmpdir(), "app-harness-dirty-root-"))
  const outside = await trackedTempDirectory(join(tmpdir(), "app-harness-dirty-outside-"))
  const tracked = join(root, "inside", "nested", "victim.txt")
  const outsideVictim = join(outside, "nested", "victim.txt")
  await mkdir(join(root, "inside", "nested"), { recursive: true })
  await writeFile(tracked, "tracked\n")
  await execFileAsync("git", ["-C", root, "init", "-q"])
  await execFileAsync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"])
  await execFileAsync("git", ["-C", root, "config", "user.name", "Harness Fixture"])
  await execFileAsync("git", ["-C", root, "add", "."])
  await execFileAsync("git", ["-C", root, "commit", "-qm", "fixture"])
  await unlink(tracked)
  const snapshot = await captureDirtyWorktree(root)
  await rmdir(join(root, "inside", "nested"))
  await rmdir(join(root, "inside"))
  await mkdir(join(outside, "nested"), { recursive: true })
  await writeFile(outsideVictim, "outside\n")
  await symlink(outside, join(root, "inside"))

  await assert.rejects(snapshot.restoreChanges, /escaped project|unsafe ancestor/)
  assert.equal(await readFile(outsideVictim, "utf8"), "outside\n")
})
