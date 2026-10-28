import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { type LaunchedDashboard, launchDashboard } from "../../src/dashboard/launcher"
import { createManifest } from "../../src/domain/manifest"
import { DecisionLedger } from "../../src/state/decision-ledger"
import { ProjectStore } from "../../src/state/project-store"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
const dashboards: LaunchedDashboard[] = []

afterEach(async () => {
  await Promise.all(dashboards.splice(0).map((dashboard) => dashboard.server.close()))
  cleanup()
})

describe("project state consistency baseline", () => {
  test("initializes regular state directories and creates an active run", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-state-baseline-"))
    const store = new ProjectStore(project)
    const manifest = createManifest(
      "run-baseline",
      "create",
      "Build an app",
      "2026-07-14T00:00:00.000Z",
    )

    // When
    await store.initialize("create", "2026-07-14T00:00:00.000Z")
    await store.createRun(manifest)

    // Then
    expect((await store.loadActiveManifest()).runId).toBe("run-baseline")
    expect(
      await readFile(join(project, ".app-harness/runs/run-baseline/manifest.json"), "utf8"),
    ).toContain('"generation": 0')
  })

  test("increments manifest generations for sequential compare-and-swap saves", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-cas-baseline-"))
    const store = new ProjectStore(project)
    await store.initialize("create", "2026-07-14T00:00:00.000Z")
    await store.createRun(
      createManifest("run-cas", "create", "Build an app", "2026-07-14T00:00:00.000Z"),
    )
    const manifest = await store.loadManifest("run-cas")

    // When
    await store.saveManifest(manifest)
    await store.saveManifest(manifest)

    // Then
    expect((await store.loadManifest("run-cas")).generation).toBe(2)
  })

  test("launches a dashboard with assets stored inside initialized project state", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-dashboard-baseline-"))
    await new ProjectStore(project).initialize("create", "2026-07-14T00:00:00.000Z")

    // When
    const dashboard = await launchDashboard({
      projectRoot: project,
      pluginRoot: resolve("."),
      open: false,
    })
    dashboards.push(dashboard)

    // Then
    expect(dashboard.snapshot).toBe(join(project, ".app-harness/dashboard/snapshot.html"))
    expect(await readFile(dashboard.snapshot, "utf8")).toContain("읽기 전용 스냅샷")
  })

  test("rejects a symlinked runs directory before writing outside project state", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-runs-link-"))
    const outside = await trackedTempDirectory(join(tmpdir(), "app-harness-runs-outside-"))
    const store = new ProjectStore(project)
    await store.initialize("create", "2026-07-14T00:00:00.000Z")
    await rm(join(project, ".app-harness/runs"), { recursive: true })
    await symlink(outside, join(project, ".app-harness/runs"))
    const manifest = createManifest(
      "run-escaped",
      "create",
      "Build an app",
      "2026-07-14T00:00:00.000Z",
    )

    // When / Then
    await expect(store.createRun(manifest)).rejects.toThrow(/unsafe|symlink/i)
    await expect(
      readFile(join(outside, "run-escaped/manifest.json"), "utf8"),
    ).rejects.toHaveProperty("code", "ENOENT")
  })

  test("rejects a symlinked dashboard directory before writing assets outside the project", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-dashboard-link-"))
    const outside = await trackedTempDirectory(join(tmpdir(), "app-harness-dashboard-outside-"))
    await new ProjectStore(project).initialize("create", "2026-07-14T00:00:00.000Z")
    await rm(join(project, ".app-harness/dashboard"), { recursive: true })
    await symlink(outside, join(project, ".app-harness/dashboard"))

    // When
    const outcome = await launchDashboard({
      projectRoot: project,
      pluginRoot: resolve("."),
      open: false,
    }).then(
      async (dashboard) => {
        await dashboard.server.close()
        return { kind: "launched" } as const
      },
      (error: unknown) => ({ kind: "rejected", error }) as const,
    )

    // Then
    expect(outcome.kind).toBe("rejected")
    await expect(readFile(join(outside, "index.html"), "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    )
  })

  test("serializes cross-instance manifest saves and rejects the stale generation", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-cas-race-"))
    const firstStore = new ProjectStore(project)
    const secondStore = new ProjectStore(project)
    await firstStore.initialize("create", "2026-07-14T00:00:00.000Z")
    await firstStore.createRun(
      createManifest("run-race", "create", "Initial", "2026-07-14T00:00:00.000Z"),
    )
    const first = await firstStore.loadManifest("run-race")
    const second = await secondStore.loadManifest("run-race")
    first.request = `first-${"a".repeat(128 * 1024)}`
    second.request = `second-${"b".repeat(128 * 1024)}`

    // When
    const results = await Promise.allSettled([
      firstStore.saveManifest(first),
      secondStore.saveManifest(second),
    ])

    // Then
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await firstStore.loadManifest("run-race")).generation).toBe(1)
  })

  test("recovers a decision append whose manifest invalidation was interrupted", async () => {
    // Given
    const project = await trackedTempDirectory(join(tmpdir(), "app-harness-recovery-"))
    const store = new ProjectStore(project)
    await store.initialize("create", "2026-07-14T00:00:00.000Z")
    const manifest = createManifest(
      "run-recovery",
      "create",
      "Build an app",
      "2026-07-14T00:00:00.000Z",
    )
    manifest.stages["scope-approval"] = {
      kind: "completed",
      inputHash: "scope",
      outputHash: "scope",
      evidenceIds: ["decision:scope-gate:1"],
      completedAt: "2026-07-14T00:00:00.000Z",
    }
    await store.createRun(manifest)
    const ledger = new DecisionLedger(project)
    await ledger.initialize({
      id: "scope-gate",
      runId: manifest.runId,
      stage: "scope-approval",
      category: "scope",
      blocking: true,
      recommendation: "Approve the focused scope.",
      alternatives: [
        { id: "focused", label: "Focused", score: 90, tradeoffs: "Smaller launch scope." },
      ],
      businessImpact: "Controls launch risk.",
      evidence: ["prd:v1"],
      actor: "harness",
      createdAt: "2026-07-14T00:00:00.000Z",
    })
    await ledger.mutate({
      id: "scope-gate",
      runId: manifest.runId,
      expectedRevision: 1,
      action: "approve",
      selected: "focused",
      reason: "Proceed.",
      actor: "user",
      idempotencyKey: "recover-scope-01",
      decidedAt: "2026-07-14T00:01:00.000Z",
    })

    // When
    const dashboard = await launchDashboard({
      projectRoot: project,
      pluginRoot: resolve("."),
      open: false,
    })
    dashboards.push(dashboard)
    const recovered = await store.loadActiveManifest()
    const secondDashboard = await launchDashboard({
      projectRoot: project,
      pluginRoot: resolve("."),
      open: false,
    })
    dashboards.push(secondDashboard)

    // Then
    const reconciledAgain = await store.loadActiveManifest()
    expect(recovered.stages["scope-approval"].kind).toBe("pending")
    expect(reconciledAgain.generation).toBe(recovered.generation)
  })
})
