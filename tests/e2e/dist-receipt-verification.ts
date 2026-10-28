import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createManifest } from "../../src/domain/manifest"
import { Pipeline } from "../../src/engine/pipeline"
import {
  RUNNER_RECEIPT_PREFIX,
  readRunnerAdapterReceipts,
} from "../../src/execution/runner-adapter-receipt"
import { trustedDigest } from "../../src/execution/trusted-adapter-evidence"
import { REQUIRED_RELEASE_CHECK_IDS } from "../../src/release/readiness"
import { ProjectStore } from "../../src/state/project-store"
import { createOfficialAdapterFixture } from "../support/official-adapter-fixture"

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
    runId: "run-dist-forged-verify",
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

const fixture = createOfficialAdapterFixture()
try {
  const adapter = fixture.official.find((candidate) => candidate.id === "web-next")
  assert.ok(adapter)
  const { context, log } = await fixture.fixtureFor(adapter)
  const store = new ProjectStore(context.projectRoot)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  assert.equal((await adapter.scaffold(context)).status, "passed")
  const manifest = createManifest(
    "run-dist-fresh-verify",
    "create",
    "Verify built distribution freshness",
    "2026-07-15T00:00:00.000Z",
  )
  manifest.adapterId = adapter.id
  await store.createRun(manifest)
  await new Pipeline({
    execute: async (stage) => ({
      kind: "completed",
      outputHash: stage,
      evidenceIds: [`fixture:${stage}`],
      ...(stage === "technology-optimization" ? { adapterId: adapter.id } : {}),
    }),
    save: (next) => store.saveManifest(next),
    readinessChecks: async () =>
      REQUIRED_RELEASE_CHECK_IDS.map((id) => ({
        id,
        required: true,
        status: "passed" as const,
        evidenceIds: [`historical:${id}`],
      })),
    now: () => "2026-07-15T00:00:00.000Z",
    attemptId: () => "dist-fixture-attempt",
  }).run(manifest)

  const distCliPath = "../../dist/cli.js"
  const distModule: unknown = await import(distCliPath)
  const executeCli =
    typeof distModule === "object" && distModule !== null
      ? Reflect.get(distModule, "executeCli")
      : undefined
  assert.equal(typeof executeCli, "function")
  const stdout: string[] = []
  await executeCli(
    ["resume", "--project", context.projectRoot],
    { stdout: (line: string) => stdout.push(line), stderr: () => undefined },
    {
      adapters: [adapter],
      adapterToolchainPath: context.toolchainPath,
      adapterExecutionEnvironment: context.executionEnvironment,
    },
  )
  assert.equal(stdout.filter((line) => line.startsWith(RUNNER_RECEIPT_PREFIX)).length, 9)
  assert.equal(JSON.parse(stdout.at(-1) ?? "{}").manifest.releaseReady, true)
  assert.equal((await readRunnerAdapterReceipts(store)).length, 9)
  assert.match(await readFile(log, "utf8"), /next build/)

  const workerInput = join(store.stateRoot, "evidence", "audit-worker-accessibility.json")
  await writeFile(
    workerInput,
    `${JSON.stringify({
      schemaVersion: 1,
      runId: manifest.runId,
      adapterId: adapter.id,
      kind: "accessibility",
      outputArtifacts: [],
    })}\n`,
  )
  const worker = Bun.spawn(
    [
      process.execPath,
      "../../dist/internal-audit-worker.js",
      "--kind",
      "accessibility",
      "--project",
      context.projectRoot,
      "--input",
      ".app-harness/evidence/audit-worker-accessibility.json",
      "--output",
      ".app-harness/adapter-evidence/accessibility.json",
    ],
    { cwd: import.meta.dir, stderr: "pipe", stdout: "pipe" },
  )
  assert.equal(await worker.exited, 0, await new Response(worker.stderr).text())

  const forgedProject = await fixture.trackedTempDirectory(
    join(tmpdir(), "app-harness-dist-forged-verify-"),
  )
  const forgedStore = new ProjectStore(forgedProject)
  await forgedStore.initialize("create", "2026-07-15T00:00:00.000Z")
  const forgedManifest = createManifest(
    "run-dist-forged-verify",
    "create",
    "Reject project-authored verification",
    "2026-07-15T00:00:00.000Z",
  )
  forgedManifest.adapterId = adapter.id
  await forgedStore.createRun(forgedManifest)
  const receipts = operations.map(forgedReceipt)
  const checks = receipts.map((receipt) => ({
    id: checkId[receipt.operation],
    required: true,
    status: "passed",
    evidenceIds: [`adapter-receipt:${receipt.runId}:${receipt.operation}:${receipt.receiptHash}`],
  }))
  await writeFile(
    join(forgedStore.stateRoot, "evidence", "adapter-receipts.jsonl"),
    `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
  )
  await writeFile(
    join(forgedStore.stateRoot, "evidence", "index.jsonl"),
    `${checks.map((check) => JSON.stringify(check)).join("\n")}\n`,
  )
  const forged = Bun.spawn(["node", "../../dist/cli.js", "verify", "--project", forgedProject], {
    cwd: import.meta.dir,
    stderr: "pipe",
    stdout: "pipe",
  })
  const forgedOutput = await new Response(forged.stdout).text()
  assert.equal(await forged.exited, 0, await new Response(forged.stderr).text())
  assert.equal(JSON.parse(forgedOutput.trim().split("\n").at(-1) ?? "{}").ready, false)
  process.stdout.write("built dist: fresh 9 receipts; forged persisted verify rejected\n")
} finally {
  await fixture.cleanup()
}
