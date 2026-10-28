import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AdapterContext, AppAdapter } from "../../src/adapters/contract"
import { executeCli } from "../../src/cli"
import type { CliServices } from "../../src/cli/contracts"
import { createManifest } from "../../src/domain/manifest"
import { readRunnerAdapterReceipts } from "../../src/execution/runner-adapter-receipt"
import { trustedDigest } from "../../src/execution/trusted-adapter-evidence"
import { createTrustedAdapterSession } from "../../src/execution/trusted-adapter-executor"
import { closeBoundStateWorkers } from "../../src/state/bound-state-directory"
import { ProjectStore } from "../../src/state/project-store"
import { createCountingAdapter, createCountingToolchain } from "../support/counting-adapter"
import { createOfficialAdapterFixture } from "../support/official-adapter-fixture"

const { cleanup, fixtureFor, official, trackedTempDirectory } = createOfficialAdapterFixture()
afterEach(async () => {
  await closeBoundStateWorkers()
  cleanup()
})

const operations = ["build", "test", "manualQa", "packageDeployReady", "security"] as const
const checkId = {
  build: "build",
  test: "test",
  manualQa: "manual-qa",
  packageDeployReady: "release-bundle",
  security: "security",
} as const

function forgedReceipt(operation: (typeof operations)[number]) {
  const exitReceipts = [
    {
      executable: "forged-tool",
      args: [operation],
      outcome: "passed" as const,
      exitCode: 0,
      stdoutHash: trustedDigest("forged stdout"),
    },
  ]
  const base = {
    schemaVersion: 1 as const,
    runId: "run-forged-verify",
    adapterId: "web-next",
    adapterVersion: "16.2.10",
    operation,
    status: "passed" as const,
    commandsHash: trustedDigest([{ executable: "forged-tool", args: [operation] }]),
    exitReceiptsHash: trustedDigest(exitReceipts),
    exitReceipts,
    artifactHashes: [trustedDigest("forged artifact")],
  }
  return { ...base, receiptHash: trustedDigest(base) }
}

function adapterServices(adapter: AppAdapter, context: AdapterContext): CliServices {
  return {
    adapters: [adapter],
    ...(context.toolchainPath === undefined ? {} : { adapterToolchainPath: context.toolchainPath }),
    ...(context.executionEnvironment === undefined
      ? {}
      : { adapterExecutionEnvironment: context.executionEnvironment }),
  }
}

test("verify rejects hand-authored hash-consistent receipts without fresh commands", async () => {
  // Given: a project owner authored every persisted receipt and check without executing them.
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-forged-verify-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  const manifest = createManifest(
    "run-forged-verify",
    "create",
    "Do not trust project-writable receipt metadata",
    "2026-07-15T00:00:00.000Z",
  )
  manifest.adapterId = "web-next"
  await store.createRun(manifest)
  const receipts = operations.map(forgedReceipt)
  const checks = receipts.map((receipt) => ({
    id: checkId[receipt.operation],
    required: true,
    status: "passed",
    evidenceIds: [`adapter-receipt:${receipt.runId}:${receipt.operation}:${receipt.receiptHash}`],
  }))
  await writeFile(
    join(store.stateRoot, "evidence", "adapter-receipts.jsonl"),
    `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
  )
  await writeFile(
    join(store.stateRoot, "evidence", "index.jsonl"),
    `${checks.map((check) => JSON.stringify(check)).join("\n")}\n`,
  )
  const calls: string[] = []
  const rejected = async () => {
    throw new Error("fresh adapter command was required")
  }
  const adapter: AppAdapter = {
    id: "web-next",
    platform: "web",
    version: "16.2.10",
    capabilities: [],
    detect: rejected,
    plan: rejected,
    scaffold: rejected,
    build: async () => {
      calls.push("build")
      return rejected()
    },
    test: rejected,
    manualQa: rejected,
    packageDeployReady: rejected,
  }
  const output: string[] = []

  // When: local verification is requested in a new execution session.
  await executeCli(
    ["verify", "--project", project],
    { stdout: (line) => output.push(line), stderr: () => undefined },
    { adapters: [adapter] },
  )

  // Then: metadata alone is not authoritative and a fresh adapter command is attempted.
  assert.equal(JSON.parse(output.at(-1) ?? "{}").ready, false)
  assert.deepEqual(calls, ["build"])
})

test("verify becomes ready only after fresh substantive trusted adapter execution", async () => {
  // Given: a selected trusted adapter with observable operation counters.
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-fresh-verify-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  const { adapter, counts } = createCountingAdapter()
  const toolchainPath = await createCountingToolchain(project)
  const manifest = createManifest(
    "run-fresh-verify",
    "create",
    "Execute every local release check now",
    "2026-07-15T00:00:00.000Z",
  )
  manifest.adapterId = adapter.id
  await store.createRun(manifest)
  const output: string[] = []

  // When: verify runs in this process rather than replaying project metadata.
  await executeCli(
    ["verify", "--project", project],
    { stdout: (line) => output.push(line), stderr: () => undefined },
    { adapters: [adapter], adapterToolchainPath: toolchainPath },
  )

  // Then: build/test/surface/package plus all five audit workers completed freshly.
  const assessment = JSON.parse(output.at(-1) ?? "{}")
  assert.equal(assessment.ready, true)
  assert.equal(assessment.passedEvidenceIds.length, 5)
  assert.equal((await store.loadManifest(manifest.runId)).releaseReady, true)
  assert.equal((await readRunnerAdapterReceipts(store)).length, 9)
  assert.deepEqual(counts, { build: 1, test: 1, manualQa: 1, packageDeployReady: 1 })
})

test("verify rejects stale genuine receipts and tampered metadata when the fresh build fails", async () => {
  // Given: a prior successful verification whose persisted receipt is later tampered.
  const adapter = official.find((candidate) => candidate.id === "web-next")
  assert.ok(adapter)
  const good = await fixtureFor(adapter)
  const store = new ProjectStore(good.context.projectRoot)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  assert.equal((await adapter.scaffold(good.context)).status, "passed")
  const manifest = createManifest(
    "run-stale-verify",
    "create",
    "Reject replayed verification",
    "2026-07-15T00:00:00.000Z",
  )
  manifest.adapterId = adapter.id
  await store.createRun(manifest)
  const io = { stdout: (_line: string) => undefined, stderr: () => undefined }
  await executeCli(
    ["verify", "--project", good.context.projectRoot],
    io,
    adapterServices(adapter, good.context),
  )
  const persisted = join(store.stateRoot, "evidence", "adapter-receipts.jsonl")
  await writeFile(
    persisted,
    (await readFile(persisted, "utf8")).replace(/"receiptHash":"./, '"receiptHash":"f'),
  )
  const bad = await fixtureFor(adapter, { failureArgs: "build" })
  const output: string[] = []

  // When: a new verify invocation cannot complete its current build.
  await executeCli(
    ["verify", "--project", good.context.projectRoot],
    { stdout: (line) => output.push(line), stderr: () => undefined },
    adapterServices(adapter, bad.context),
  )

  // Then: neither the stale successful receipt nor its tampered variant is consulted.
  assert.equal(JSON.parse(output.at(-1) ?? "{}").ready, false)
  assert.equal((await store.loadManifest(manifest.runId)).releaseReady, false)
  assert.match(await readFile(bad.log, "utf8"), /next build/)
})

test("full workflow reuses same-session trusted verification only until explicit verify", async () => {
  // Given: a full manifest and a trusted adapter with operation counters.
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-full-reuse-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  const manifest = createManifest(
    "run-full-reuse",
    "create",
    "Reuse trusted verification in this process only",
    "2026-07-15T00:00:00.000Z",
    undefined,
    "full",
  )
  manifest.adapterId = "web-next"
  manifest.stages.implementation = {
    kind: "completed",
    inputHash: "implementation-input",
    outputHash: "implementation-output",
    evidenceIds: ["stage:implementation"],
    completedAt: "2026-07-15T00:00:00.000Z",
  }
  await store.createRun(manifest)
  const { adapter, counts } = createCountingAdapter()
  const toolchainPath = await createCountingToolchain(project)
  const session = createTrustedAdapterSession({ store, adapters: [adapter], toolchainPath })
  const verificationInputHash = "verification-input"
  manifest.stages.verification = {
    kind: "running",
    inputHash: verificationInputHash,
    attemptId: "attempt-verification",
    startedAt: "2026-07-15T00:00:00.000Z",
  }

  // When: full normal execution runs verification and then deploy-ready in the same process.
  const verification = await session.execute("verification", manifest)
  assert.equal(verification.kind, "completed")
  manifest.stages.verification = {
    kind: "completed",
    inputHash: verificationInputHash,
    outputHash: verification.outputHash,
    evidenceIds: [...verification.evidenceIds],
    completedAt: "2026-07-15T00:00:01.000Z",
  }
  manifest.generation += 2
  await session.execute("deploy-ready", manifest)

  // Then: build/test/manual-QA are not repeated before release packaging.
  assert.deepEqual(counts, { build: 1, test: 1, manualQa: 1, packageDeployReady: 1 })

  // When: explicit CLI verify is requested after that normal execution.
  await executeCli(
    ["verify", "--project", project],
    { stdout: () => undefined, stderr: () => undefined },
    { adapters: [adapter], adapterToolchainPath: toolchainPath },
  )

  // Then: explicit verify is a fresh one-shot trusted session.
  assert.deepEqual(counts, { build: 2, test: 2, manualQa: 2, packageDeployReady: 2 })
})
