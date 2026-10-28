import assert from "node:assert/strict"
import test from "node:test"

import { createManifest, RunManifestSchema } from "../../src/domain/manifest.js"
import { Pipeline } from "../../src/engine/pipeline.js"
import { REQUIRED_RELEASE_CHECK_IDS } from "../../src/release/readiness.js"

test("pipeline stops at Gate 1 and exposes no more than three blockers", async () => {
  const manifest = createManifest("run-1", "create", "Build a shop", "2026-01-01T00:00:00.000Z")
  const saves: (typeof manifest)[] = []
  const pipeline = new Pipeline({
    execute: async (stage) =>
      stage === "scope-approval"
        ? { kind: "blocked", decisionIds: ["scope", "privacy"] }
        : { kind: "completed", outputHash: stage, evidenceIds: [`ev-${stage}`] },
    save: async (next) => {
      saves.push(structuredClone(next))
    },
    now: () => "2026-01-01T00:00:00.000Z",
  })

  const result = await pipeline.run(manifest)
  assert.equal(result.kind, "blocked")
  assert.equal(result.stage, "scope-approval")
  assert.equal(saves.at(-1)?.stages["scope-approval"].kind, "blocked")
})

test("pipeline rejects a stage exposing more than three blocking decisions", async () => {
  const manifest = createManifest("run-2", "create", "Build a shop", "2026-01-01T00:00:00.000Z")
  const pipeline = new Pipeline({
    execute: async () => ({ kind: "blocked", decisionIds: ["1", "2", "3", "4"] }),
    save: async () => undefined,
  })
  await assert.rejects(() => pipeline.run(manifest), /maximum of 3/)
})

test("resume is idempotent for completed stages", async () => {
  const manifest = createManifest("run-3", "resume", "Build a shop", "2026-01-01T00:00:00.000Z")
  manifest.stages["request-analysis"] = {
    kind: "completed",
    inputHash: "run-3:request-analysis",
    outputHash: "done",
    evidenceIds: ["ev"],
    completedAt: "2026-01-01T00:00:00.000Z",
  }
  const executed: string[] = []
  const pipeline = new Pipeline({
    inputHash: (_manifest, stage) => `${_manifest.runId}:${stage}`,
    execute: async (stage) => {
      executed.push(stage)
      return { kind: "blocked", decisionIds: ["gate"] }
    },
    save: async () => undefined,
  })
  await pipeline.run(manifest)
  assert.equal(executed.includes("request-analysis"), false)
})

test("lean manifests skip separate model verification with a stable reason", async () => {
  // Given: a newly created run uses the lean execution profile.
  const manifest = createManifest("run-lean", "create", "Build", "2026-01-01T00:00:00.000Z")
  const executed: string[] = []
  const pipeline = new Pipeline({
    execute: async (stage) => {
      executed.push(stage)
      return { kind: "completed", outputHash: stage, evidenceIds: [`stage:${stage}`] }
    },
    save: async () => undefined,
    readinessChecks: async () =>
      REQUIRED_RELEASE_CHECK_IDS.map((id) => ({
        id,
        required: true,
        status: "passed" as const,
        evidenceIds: [`evidence:${id}`],
      })),
  })

  // When: the pipeline reaches the release boundary.
  await pipeline.run(manifest)

  // Then: only the separate model verification stage is skipped.
  assert.equal(manifest.workflowProfile, "lean")
  assert.equal(executed.includes("verification"), false)
  assert.equal(manifest.stages.verification.kind, "skipped")
  if (manifest.stages.verification.kind === "skipped") {
    assert.equal(
      manifest.stages.verification.reason,
      "lean-profile-trusted-verification-runs-at-deploy-ready",
    )
  }
  assert.equal(executed.includes("deploy-ready"), true)
  assert.equal(manifest.releaseReady, true)
})

test("legacy manifests missing workflowProfile parse as full", () => {
  // Given: a persisted manifest from before workflow profiles existed.
  const legacy = structuredClone(
    createManifest("run-legacy", "create", "Build", "2026-01-01T00:00:00.000Z"),
  )
  Reflect.deleteProperty(legacy, "workflowProfile")

  // When: state is read through the boundary schema.
  const parsed = RunManifestSchema.parse(legacy)

  // Then: old persisted behavior remains explicit full execution.
  assert.equal(parsed.workflowProfile, "full")
})

test("resume replaces legacy placeholder completion with a substantive stage result", async () => {
  const manifest = createManifest(
    "run-placeholder",
    "resume",
    "Build a shop",
    "2026-01-01T00:00:00.000Z",
  )
  manifest.stages["request-analysis"] = {
    kind: "completed",
    inputHash: "run-placeholder:request-analysis",
    outputHash: "request-analysis",
    evidenceIds: ["state:request-analysis"],
    completedAt: "2026-01-01T00:00:00.000Z",
  }
  const executed: string[] = []
  const pipeline = new Pipeline({
    inputHash: (_manifest, stage) => `${_manifest.runId}:${stage}`,
    execute: async (stage) => {
      executed.push(stage)
      return stage === "scope-approval"
        ? { kind: "blocked", decisionIds: ["gate"] }
        : { kind: "completed", outputHash: `real:${stage}`, evidenceIds: [`real:${stage}`] }
    },
    save: async () => undefined,
  })

  await pipeline.run(manifest)

  assert.equal(executed[0], "request-analysis")
  assert.equal(manifest.stages["request-analysis"].kind, "completed")
  if (manifest.stages["request-analysis"].kind === "completed") {
    assert.equal(manifest.stages["request-analysis"].outputHash, "real:request-analysis")
  }
})

test("Gate 2 is reached only after design candidates", async () => {
  const manifest = createManifest("run-4", "extend", "Extend an API", "2026-01-01T00:00:00.000Z")
  const seen: string[] = []
  const pipeline = new Pipeline({
    execute: async (stage) => {
      seen.push(stage)
      return stage === "design-selection"
        ? { kind: "blocked", decisionIds: ["design-direction"] }
        : { kind: "completed", outputHash: stage, evidenceIds: [`ev-${stage}`] }
    },
    save: async () => undefined,
  })
  await pipeline.run(manifest)
  assert.ok(seen.indexOf("design-candidates") < seen.indexOf("design-selection"))
})

test("completed stages without evidence stop as unverified", async () => {
  // Given
  const manifest = createManifest("run-empty", "create", "Build", "2026-01-01T00:00:00.000Z")
  const pipeline = new Pipeline({
    execute: async (stage) => ({ kind: "completed", outputHash: stage, evidenceIds: [] }),
    save: async () => undefined,
  })

  // When
  const result = await pipeline.run(manifest)

  // Then
  assert.equal(result.kind, "unverified")
  assert.equal(manifest.stages["request-analysis"].kind, "unverified")
  assert.equal(manifest.releaseReady, false)
})

test("stage completion alone never claims release readiness", async () => {
  // Given
  const manifest = createManifest("run-no-checks", "create", "Build", "2026-01-01T00:00:00.000Z")
  const pipeline = new Pipeline({
    execute: async (stage) => ({
      kind: "completed",
      outputHash: stage,
      evidenceIds: [`stage:${stage}`],
    }),
    save: async () => undefined,
  })

  // When
  const result = await pipeline.run(manifest)

  // Then
  assert.equal(result.kind, "completed")
  assert.equal(manifest.releaseReady, false)
})

test("failed required readiness checks override completed pipeline stages", async () => {
  // Given
  const manifest = createManifest("run-failed-check", "create", "Build", "2026-01-01T00:00:00.000Z")
  const pipeline = new Pipeline({
    execute: async (stage) => ({
      kind: "completed",
      outputHash: stage,
      evidenceIds: [`stage:${stage}`],
    }),
    save: async () => undefined,
    readinessChecks: async () => [
      { id: "security", required: true, status: "failed", evidenceIds: ["security:failure"] },
    ],
    requiredCheckIds: ["security"],
  })

  // When
  await pipeline.run(manifest)

  // Then
  assert.equal(manifest.releaseReady, false)
})

test("all required checks with evidence permit a release-ready result", async () => {
  // Given
  const manifest = createManifest("run-ready", "create", "Build", "2026-01-01T00:00:00.000Z")
  const pipeline = new Pipeline({
    execute: async (stage) => ({
      kind: "completed",
      outputHash: stage,
      evidenceIds: [`stage:${stage}`],
    }),
    save: async () => undefined,
    readinessChecks: async () =>
      REQUIRED_RELEASE_CHECK_IDS.map((id) => ({
        id,
        required: true,
        status: "passed" as const,
        evidenceIds: [`evidence:${id}`],
      })),
  })

  // When
  await pipeline.run(manifest)

  // Then
  assert.equal(manifest.releaseReady, true)
})
