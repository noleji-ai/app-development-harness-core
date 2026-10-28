import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"

import type { AdapterResult, AppAdapter } from "../../src/adapters/contract"
import { createManifest } from "../../src/domain/manifest"
import {
  createReceipt,
  persistTrustedEvidence,
  readinessCheck,
} from "../../src/execution/trusted-adapter-evidence"
import { createTrustedAdapterExecutor } from "../../src/execution/trusted-adapter-executor"
import { ProjectStore } from "../../src/state/project-store"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

const passed: AdapterResult = {
  status: "passed",
  summary: "local command passed",
  commands: [{ executable: "fixture-tool", args: ["build"] }],
  commandReceipts: [
    {
      executable: "fixture-tool",
      args: ["build"],
      outcome: "passed",
      exitCode: 0,
      stdoutHash: createHash("sha256").update("fixture output").digest("hex"),
    },
  ],
  outputArtifacts: [
    {
      path: "dist/fixture.bin",
      sha256: createHash("sha256").update("fixture artifact").digest("hex"),
      size: 16,
    },
  ],
}
const adapter: AppAdapter = {
  id: "fixture-adapter",
  platform: "web",
  version: "1.0.0",
  capabilities: ["build", "test", "manual-qa", "deploy-ready"],
  detect: async () => passed,
  plan: async () => passed,
  scaffold: async () => passed,
  build: async () => passed,
  test: async () => passed,
  manualQa: async () => passed,
  packageDeployReady: async () => passed,
}

async function fixture() {
  const project = await trackedTempDirectory(join(tmpdir(), "trusted-evidence-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-14T00:00:00.000Z")
  const manifest = createManifest(
    "run-trusted-evidence",
    "create",
    "Build",
    "2026-07-14T00:00:00.000Z",
  )
  return { manifest, store }
}

test("trusted evidence rejects missing and duplicate command receipts", async () => {
  const { manifest, store } = await fixture()
  assert.throws(() =>
    createReceipt(manifest, adapter, "build", {
      ...passed,
      commands: [],
      commandReceipts: [],
    }),
  )
  const receipt = createReceipt(manifest, adapter, "build", passed)
  await assert.rejects(
    persistTrustedEvidence(store, [receipt, receipt], [readinessCheck("build", receipt)]),
    /duplicate/i,
  )
})

test("trusted evidence rejects a successful receipt correlated to the wrong command", async () => {
  const { manifest } = await fixture()
  const commandReceipt = passed.commandReceipts?.[0]
  assert.ok(commandReceipt)

  assert.throws(
    () =>
      createReceipt(manifest, adapter, "build", {
        ...passed,
        commandReceipts: [{ ...commandReceipt, args: ["different-command"] }],
      }),
    /correlation/i,
  )
})

test("trusted evidence rejects unknown checks and model evidence identifiers", async () => {
  const { manifest, store } = await fixture()
  const receipt = createReceipt(manifest, adapter, "build", passed)
  await assert.rejects(
    persistTrustedEvidence(store, [receipt], [readinessCheck("unknown-check", receipt)]),
    /unknown/i,
  )
  await assert.rejects(
    persistTrustedEvidence(
      store,
      [receipt],
      [{ id: "build", required: true, status: "passed", evidenceIds: ["model:fake"] }],
    ),
    /untrusted/i,
  )
})

test("trusted executor rejects passed no-op adapter results", async () => {
  const { manifest, store } = await fixture()
  manifest.adapterId = adapter.id
  const execute = createTrustedAdapterExecutor({ store, adapters: [adapter] })

  const result = await execute("verification", manifest)

  assert.equal(result.kind, "unverified")
  assert.deepEqual(await store.readEvidenceLines(), [])
})
