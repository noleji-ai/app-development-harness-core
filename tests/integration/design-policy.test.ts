import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { executeCli } from "../../src/cli/commands"
import { resolveRunInput } from "../../src/cli/request-input"
import { DEFAULT_DESIGN_POLICY, resolveDesignPolicy } from "../../src/domain/design-policy"
import { DecisionLedger } from "../../src/state/decision-ledger"
import { ProjectStore } from "../../src/state/project-store"
import { createGateCodexFixture } from "../support/gate-codex-fixture"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

test("normal customer applications retain the required design policy by default", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "design-default-required-"))

  // When
  await executeCli(
    [
      "run",
      "--project",
      project,
      "--request",
      "Build a customer launch dashboard with API integrations and accessible workflows.",
    ],
    { stdout: () => undefined, stderr: () => undefined },
    {
      runId: () => "run-customer",
      now: () => "2026-07-15T00:00:00.000Z",
      executeStage: async (stage) =>
        stage === "design-selection"
          ? { kind: "blocked", decisionIds: ["design"] }
          : { kind: "completed", outputHash: stage, evidenceIds: [`stage:${stage}`] },
    },
  )

  // Then
  const manifest = await new ProjectStore(project).loadManifest("run-customer")
  expect(manifest.designPolicy).toMatchObject({ mode: "required", source: "default" })
  expect(manifest.stages["design-candidates"].kind).toBe("completed")
  expect(manifest.stages["design-selection"].kind).toBe("blocked")
})

test("headless policy delegates an automatic nonblocking API and operations direction", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "design-auto-delegated-"))
  const binary = await createGateCodexFixture(project)
  const io = { stdout: () => undefined, stderr: () => undefined }
  const services = {
    codexBinary: binary,
    runId: () => "run-headless-delegated",
    now: () => "2026-07-15T00:00:00.000Z",
  }
  await executeCli(
    ["run", "--project", project, "--request", "Build a backend-only event processing worker."],
    io,
    services,
  )
  const ledger = new DecisionLedger(project)
  const scope = (await ledger.listRun("run-headless-delegated"))[0]
  if (scope === undefined) throw new Error("scope gate was not created")
  await ledger.mutate({
    id: scope.id,
    runId: scope.runId,
    expectedRevision: scope.revision,
    action: "approve",
    selected: "focused-v1",
    reason: "Approve the headless scope.",
    actor: "user",
    idempotencyKey: "approve-headless-scope",
    decidedAt: "2026-07-15T00:01:00.000Z",
  })

  // When
  await executeCli(["resume", "--project", project], io, services)

  // Then
  const manifest = await new ProjectStore(project).loadManifest("run-headless-delegated")
  const design = (await ledger.listRun("run-headless-delegated")).find(
    (decision) => decision.stage === "design-selection",
  )
  expect(manifest.designPolicy).toMatchObject({ mode: "delegated", source: "auto" })
  expect(manifest.stages["design-candidates"].kind).toBe("skipped")
  expect(manifest.stages["design-selection"].kind).toBe("completed")
  expect(design).toMatchObject({
    blocking: false,
    status: "approved",
    selected: "api-contract-first",
  })
})

test("mixed headless and customer-facing products retain mandatory design", () => {
  // Given
  const request = "Build a headless CMS with a customer-facing storefront and mobile app."

  // When
  const policy = resolveDesignPolicy(request, undefined, DEFAULT_DESIGN_POLICY)

  // Then
  expect(policy).toMatchObject({ mode: "required", source: "default" })
})

const MIXED_DESIGN_REQUESTS = [
  ["iOS and Android clients", "Build a headless backend with an iOS client and an Android client."],
  ["consumer app", "Build a headless CMS and a consumer app."],
  ["desktop application", "Build an API-only service plus a desktop application."],
  ["ordinary client application", "Build a backend-only service with a client application."],
  ["Korean client app", "backend-only 서비스와 iOS 클라이언트 앱을 구축합니다."],
  ["Korean desktop application", "API-only 백엔드와 데스크톱 애플리케이션을 함께 구축합니다."],
  ["no UI plus desktop client", "No UI for the API-only service plus a desktop client."],
] as const

for (const [label, request] of MIXED_DESIGN_REQUESTS) {
  test(`ambiguous mixed product defaults to required design: ${label}`, () => {
    // Given / When
    const policy = resolveDesignPolicy(request, undefined, DEFAULT_DESIGN_POLICY)

    // Then
    expect(policy).toMatchObject({ mode: "required", source: "default" })
  })
}

test("unambiguous single-surface backend requests may still auto-delegate", () => {
  // Given
  const request = "Build an API-only invoice reconciliation service."

  // When
  const policy = resolveDesignPolicy(request, undefined, DEFAULT_DESIGN_POLICY)

  // Then
  expect(policy).toMatchObject({ mode: "delegated", source: "auto" })
})

test("free-text no-UI language defaults to required until skip is structured", () => {
  // Given
  const request = "Build a batch reconciliation worker with no UI."

  // When
  const policy = resolveDesignPolicy(request, undefined, DEFAULT_DESIGN_POLICY)

  // Then
  expect(policy).toMatchObject({ mode: "required", source: "default" })
})

test("explicit structured policy remains authoritative for a mixed request", () => {
  // Given
  const request = "Build a headless backend with iOS and Android clients."

  // When
  const policy = resolveDesignPolicy(
    request,
    { mode: "delegated", reason: "The existing client teams own all interface design." },
    DEFAULT_DESIGN_POLICY,
  )

  // Then
  expect(policy).toMatchObject({ mode: "delegated", source: "explicit" })
})

test("config and JSON request boundaries persist explicit documented policies", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "design-policy-boundaries-"))
  const reason = "This batch interface has no human-facing design surface."
  await writeFile(
    join(project, "request.json"),
    `${JSON.stringify({ request: "Build a batch processor", designPolicy: { mode: "skip", reason } })}\n`,
  )

  // When
  const input = await resolveRunInput(project, ["--request-file", "request.json"])
  await executeCli(["init", "--project", project, "--design-policy", "delegated"], {
    stdout: () => undefined,
    stderr: () => undefined,
  })

  // Then
  expect(input.designPolicy).toEqual({ mode: "skip", reason })
  const config = JSON.parse(await readFile(join(project, ".app-harness/config.json"), "utf8"))
  expect(config.designPolicy).toMatchObject({ mode: "delegated", source: "explicit" })
})

test("skip policy is rejected without a documented product reason", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "design-policy-reason-"))
  await expect(
    resolveRunInput(project, ["--request", "Build a worker", "--design-policy", "skip"]),
  ).rejects.toThrow(/documented product reason/i)
})
