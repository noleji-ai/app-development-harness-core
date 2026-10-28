import { afterEach, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createManifest } from "../../src/domain/manifest"
import { ProjectStore } from "../../src/state/project-store"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

test("project state readers reject malformed JSON boundaries", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-boundary-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-13T00:00:00.000Z")
  await writeFile(join(project, ".app-harness/config.json"), '{"mode":"create"}\n')
  await expect(store.readConfig()).rejects.toThrow()
})

test("decision changes invalidate the affected manifest checkpoint", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-invalidate-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-13T00:00:00.000Z")
  const manifest = createManifest(
    "run-invalidate",
    "create",
    "Build an app",
    "2026-07-13T00:00:00.000Z",
  )
  for (const stage of ["request-analysis", "research-prd", "scope-approval"] as const) {
    manifest.stages[stage] = {
      kind: "completed",
      inputHash: stage,
      outputHash: stage,
      evidenceIds: [`evidence:${stage}`],
      completedAt: "2026-07-13T00:00:00.000Z",
    }
  }
  await store.createRun(manifest)

  await store.invalidateFrom("scope-approval", "2026-07-13T01:00:00.000Z")

  const updated = await store.loadActiveManifest()
  expect(updated.currentStage).toBe("scope-approval")
  expect(updated.stages["scope-approval"].kind).toBe("pending")
  expect(updated.stages["request-analysis"].kind).toBe("completed")
  expect(updated.releaseReady).toBeFalse()
})
