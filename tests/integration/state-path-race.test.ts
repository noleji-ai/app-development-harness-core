import { afterEach, describe, expect, test } from "bun:test"
import { readdir, rename, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { atomicWriteStateFile } from "../../src/state/atomic-state-file"
import { ProjectStore } from "../../src/state/project-store"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("state pathname race containment", () => {
  test("never redirects dashboard writes through a swapped parent symlink", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-path-race-"))
    const external = await trackedTempDirectory(join(tmpdir(), "app-harness-path-outside-"))
    await new ProjectStore(project).initialize("create", "2026-07-14T00:00:00.000Z")
    const dashboard = join(project, ".app-harness/dashboard")
    const parked = join(project, ".app-harness/dashboard.real")
    const completed: string[] = []
    await atomicWriteStateFile(project, join(dashboard, "seed.html"), "seed")
    let swapping = true
    const swapper = (async () => {
      while (swapping) {
        for (let turn = 0; turn < 8; turn += 1) await nextTurn()
        await rename(dashboard, parked)
        await symlink(external, dashboard)
        for (let turn = 0; turn < 3; turn += 1) await nextTurn()
        await unlink(dashboard)
        await rename(parked, dashboard)
      }
    })()

    // When
    try {
      for (let batch = 0; batch < 273; batch += 1) {
        await Promise.all(
          Array.from({ length: 10 }, (_, offset) =>
            atomicWriteStateFile(
              project,
              join(dashboard, `attempt-${batch * 10 + offset}.html`),
              `attempt-${batch * 10 + offset}`,
            ).then(
              () => completed.push(`attempt-${batch * 10 + offset}.html`),
              () => undefined,
            ),
          ),
        )
      }
    } finally {
      swapping = false
      await swapper
    }

    // Then
    const localFiles = new Set(await readdir(dashboard))
    expect(completed.length).toBeGreaterThan(0)
    expect(completed.every((name) => localFiles.has(name))).toBe(true)
    expect(await readdir(external)).toEqual([])
  }, 30_000)
})
