import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { executeCli } from "../../src/cli/commands"
import { closeBoundStateWorkers } from "../../src/state/bound-state-directory"
import { DecisionLedger } from "../../src/state/decision-ledger"
import { ProjectStore } from "../../src/state/project-store"
import { createCountingAdapter, createCountingToolchain } from "../support/counting-adapter"
import { createGateCodexFixture } from "../support/gate-codex-fixture"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(async () => {
  await closeBoundStateWorkers()
  cleanup()
})

test("a later run cannot inherit gate approval and a changed decision blocks resume", async () => {
  // Given: run A reaches and approves its own scope gate.
  const project = await trackedTempDirectory(join(tmpdir(), "run-scoped-gates-e2e-"))
  const binary = await createGateCodexFixture(project)
  const io = { stdout: () => undefined, stderr: () => undefined }
  let runId = "run-a"
  const services = {
    codexBinary: binary,
    runId: () => runId,
    now: () => "2026-07-15T00:00:00.000Z",
  }
  await executeCli(
    [
      "run",
      "--project",
      project,
      "--workflow-profile",
      "full",
      "--request",
      "Build a customer app",
    ],
    io,
    services,
  )
  const ledger = new DecisionLedger(project)
  const first = (await ledger.listRun("run-a"))[0]
  expect(first?.status).toBe("pending")
  if (first === undefined) throw new Error("run A gate was not created")
  await ledger.mutate({
    id: first.id,
    runId: first.runId,
    expectedRevision: first.revision,
    action: "approve",
    selected: "focused-v1",
    reason: "Approve run A only.",
    actor: "user",
    idempotencyKey: "approve-run-a-scope",
    decidedAt: "2026-07-15T00:01:00.000Z",
  })

  // When: run B begins in the same project.
  runId = "run-b"
  await executeCli(
    [
      "run",
      "--project",
      project,
      "--workflow-profile",
      "full",
      "--request",
      "Build a second customer app",
    ],
    io,
    services,
  )

  // Then: run B has an independent pending gate and run A history remains approved.
  const second = (await ledger.listRun("run-b"))[0]
  expect(second?.status).toBe("pending")
  expect((await ledger.listRun("run-a"))[0]?.status).toBe("approved")
  if (second === undefined) throw new Error("run B gate was not created")

  // Given: run B approval completes the scope checkpoint.
  await ledger.mutate({
    id: second.id,
    runId: second.runId,
    expectedRevision: second.revision,
    action: "approve",
    selected: "focused-v1",
    reason: "Approve run B scope.",
    actor: "user",
    idempotencyKey: "approve-run-b-scope",
    decidedAt: "2026-07-15T00:02:00.000Z",
  })
  await executeCli(["resume", "--project", project], io, services)
  expect(
    (await new ProjectStore(project).loadManifest("run-b")).stages["scope-approval"].kind,
  ).toBe("completed")

  // When: the same run changes that approved decision and resumes.
  await ledger.mutate({
    id: second.id,
    runId: second.runId,
    expectedRevision: 2,
    action: "request_revision",
    reason: "Narrow run B before implementation.",
    actor: "user",
    idempotencyKey: "revise-run-b-scope",
    decidedAt: "2026-07-15T00:03:00.000Z",
  })
  await executeCli(["resume", "--project", project], io, services)

  // Then: resume re-enters the changed run B gate without changing run A history.
  const manifest = await new ProjectStore(project).loadManifest("run-b")
  expect(manifest.currentStage).toBe("scope-approval")
  expect(manifest.stages["scope-approval"].kind).toBe("blocked")
  expect(await ledger.history(second.id, "run-b")).toHaveLength(3)
  expect(await ledger.history(first.id, "run-a")).toHaveLength(2)
})

test("default lean run records routine gate decisions and verifies trusted work once", async () => {
  // Given: the default run profile and a trusted adapter with observable operation counters.
  const project = await trackedTempDirectory(join(tmpdir(), "run-lean-gates-e2e-"))
  const binary = await createGateCodexFixture(project)
  const toolchainPath = await createCountingToolchain(project)
  const { adapter, counts } = createCountingAdapter()
  const output: string[] = []

  // When: a run starts without an explicit full override.
  await executeCli(
    ["run", "--project", project, "--request", "Build a customer app"],
    { stdout: (line) => output.push(line), stderr: () => undefined },
    {
      adapters: [adapter],
      adapterToolchainPath: toolchainPath,
      codexBinary: binary,
      runId: () => "run-lean-default",
      now: () => "2026-07-15T00:00:00.000Z",
    },
  )

  // Then: routine gates are recorded as approved and trusted checks run once at deploy-ready.
  const store = new ProjectStore(project)
  const manifest = await store.loadManifest("run-lean-default")
  const decisions = await new DecisionLedger(project).listRun("run-lean-default")
  expect(manifest.workflowProfile).toBe("lean")
  expect(manifest.stages["scope-approval"].kind).toBe("completed")
  expect(manifest.stages["design-selection"].kind).toBe("completed")
  expect(manifest.stages.verification.kind).toBe("skipped")
  expect(decisions.find((decision) => decision.id === "gate-1-prd-scope")?.selected).toBe(
    "focused-v1",
  )
  expect(decisions.find((decision) => decision.id === "gate-2-design-direction")?.selected).toBe(
    "clarity-first",
  )
  expect(decisions.every((decision) => decision.status === "approved")).toBeTrue()
  expect(counts).toEqual({ build: 1, test: 1, manualQa: 1, packageDeployReady: 1 })
  expect(manifest.releaseReady).toBeTrue()
  expect(JSON.parse(output.at(-1) ?? "{}").kind).toBe("completed")
})
