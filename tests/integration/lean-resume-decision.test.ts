import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

import { executeCli } from "../../src/cli/commands"
import { closeBoundStateWorkers } from "../../src/state/bound-state-directory"
import { DecisionLedger } from "../../src/state/decision-ledger"
import { ProjectStore } from "../../src/state/project-store"
import { createCountingAdapter, createCountingToolchain } from "../support/counting-adapter"
import { createGateCodexFixture } from "../support/gate-codex-fixture"
import { createTempDirectoryTracker } from "../support/temp-directory"

const tracker = createTempDirectoryTracker()
afterEach(async () => {
  await closeBoundStateWorkers()
  tracker.cleanup()
})

test("resuming a later failed stage does not repeat design after consuming lean approvals", async () => {
  // Given a real CLI pipeline with deterministic model transport failing at technology selection.
  const project = await tracker.create(join(tmpdir(), "lean-resume-decisions-"))
  const binary = await createGateCodexFixture(project)
  const source = await readFile(binary, "utf8")
  await writeFile(
    binary,
    source
      .replace(
        'status: "completed",',
        'status: context.stage === "technology-optimization" ? "failed" : "completed",',
      )
      .replace(
        'error: "",',
        'error: context.stage === "technology-optimization" ? "deliberate stage failure" : "",',
      )
      .replace(
        "const artifactId =",
        'if (context.stage === "technology-optimization") fs.writeFileSync(path.join(project, "technology-adr.md"), "A downstream technology decision note");\n  const artifactId =',
      ),
  )
  const io = { stdout: () => undefined, stderr: () => undefined }
  const services = { codexBinary: binary, runId: () => "run-lean-retry" }
  await executeCli(["run", "--project", project, "--request", "Build a customer app"], io, services)

  // When the unchanged failed run resumes through normal decision reconciliation.
  await executeCli(["resume", "--project", project], io, services)

  // Then already consumed scope/design approvals cause no repeated design model call.
  const ledger = await readFile(join(project, ".app-harness/evidence/model-usage.jsonl"), "utf8")
  const rows = ledger
    .trim()
    .split("\n")
    .map((line) => z.object({ event: z.string(), stage: z.string() }).parse(JSON.parse(line)))
  expect(
    rows.filter((row) => row.event === "finished" && row.stage === "design-candidates"),
  ).toHaveLength(1)
  expect(
    rows.filter((row) => row.event === "finished" && row.stage === "technology-optimization"),
  ).toHaveLength(2)
})

test("given lean approval, when the user rejects it, then resume blocks at that gate", async () => {
  const project = await tracker.create(join(tmpdir(), "lean-explicit-rejection-"))
  const binary = await createGateCodexFixture(project)
  const toolchain = await createCountingToolchain(project)
  const { adapter } = createCountingAdapter()
  const services = {
    codexBinary: binary,
    adapters: [adapter],
    adapterToolchainPath: toolchain,
    runId: () => "run-lean-rejected",
  }
  const io = { stdout: () => undefined, stderr: () => undefined }
  await executeCli(["run", "--project", project, "--request", "Build a customer app"], io, services)
  const ledger = new DecisionLedger(project)
  const decision = (await ledger.listRun("run-lean-rejected")).find(
    (item) => item.id === "gate-1-prd-scope",
  )
  if (decision === undefined) throw new Error("Scope approval missing")
  await ledger.mutate({
    id: decision.id,
    runId: decision.runId,
    expectedRevision: decision.revision,
    action: "reject",
    reason: "The user no longer approves this scope.",
    actor: "user",
    idempotencyKey: "reject-lean-scope",
    decidedAt: new Date().toISOString(),
  })

  await executeCli(["resume", "--project", project], io, services)

  const manifest = await new ProjectStore(project).loadManifest("run-lean-rejected")
  expect(manifest.currentStage).toBe("scope-approval")
  expect(manifest.stages["scope-approval"].kind).toBe("blocked")
  expect(manifest.releaseReady).toBeFalse()
})
