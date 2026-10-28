import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createManifest } from "../../src/domain/manifest"
import { collectRunArtifact } from "../../src/execution/artifact-collection"
import {
  digest,
  sealRunCheckpoints,
  validCheckpoint,
  writeCheckpoint,
} from "../../src/execution/codex-stage-checkpoint"
import { ModelPolicySchema, resolveModelPolicy } from "../../src/execution/model-policy"
import { captureTrustedEvidence } from "../../src/execution/trusted-evidence-guard"
import { workspaceDigest } from "../../src/execution/workspace-digest"
import { atomicWriteStateFile } from "../../src/state/atomic-state-file"
import { ProjectStore } from "../../src/state/project-store"

async function fixture(root: string, stage: "implementation" | "deploy-ready") {
  const store = new ProjectStore(root)
  await store.initialize("create")
  const manifest = createManifest("run-proof", "create", "test")
  const inputHash = "d".repeat(64),
    outputHash = "c".repeat(64)
  manifest.stages[stage] = {
    kind: "completed",
    inputHash,
    outputHash: `${outputHash}:trusted`,
    evidenceIds: ["proof"],
    completedAt: new Date().toISOString(),
  }
  await store.createRun(manifest)
  await writeFile(join(root, "artifact.txt"), "ready")
  const policy = ModelPolicySchema.parse(resolveModelPolicy(stage))
  const attemptId = "attempt-one"
  const usageRef = `model-execution-${digest(`${manifest.runId}:${attemptId}`)}.json`
  const usage = JSON.stringify({
    runId: manifest.runId,
    stage,
    attemptId,
    inputHash,
    policy,
    event: "finished",
    outcome: "completed",
    transportOutcome: "output",
    modelCalls: 1,
    startedAt: new Date().toISOString(),
    wallMs: 1,
    usage: null,
  })
  await atomicWriteStateFile(root, join(store.stateRoot, "evidence", usageRef), usage)
  const path = join(store.stateRoot, "evidence", `codex-${"e".repeat(64)}.checkpoint.json`)
  await writeCheckpoint(store, path, {
    schemaVersion: 3,
    runId: manifest.runId,
    stage,
    inputHash,
    policyHash: digest(JSON.stringify(policy)),
    usageRef,
    usageHash: digest(usage),
    sourceHash: await workspaceDigest(root),
    transport: "exec",
    transcriptHash: "f".repeat(64),
    artifacts: [{ id: "artifact", path: "artifact.txt", sha256: digest("ready") }],
    result: { kind: "completed", outputHash, evidenceIds: ["proof"] },
    completedAt: new Date().toISOString(),
  })
  return { store, manifest, path, usageRef, usage, inputHash }
}

test("newly planted checkpoint and usage files are removed before they can be replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-plant-"))
  try {
    const store = new ProjectStore(root)
    await store.initialize("create")
    const restore = await captureTrustedEvidence(store)
    const paths = [
      `codex-${"a".repeat(64)}.checkpoint.json`,
      `model-execution-${"b".repeat(64)}.json`,
    ].map((name) => join(store.stateRoot, "evidence", name))
    for (const path of paths) await writeFile(path, "{}")
    assert.equal(await restore(), true)
    for (const path of paths) await assert.rejects(() => access(path))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("trusted composite stage hashes are sealed and invalidated artifacts cannot be collected", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-seal-"))
  try {
    const value = await fixture(root, "deploy-ready")
    await sealRunCheckpoints(value.store, value.manifest)
    const checkpoint = JSON.parse(await readFile(value.path, "utf8"))
    assert.equal(checkpoint.finalStageOutputHash, `${"c".repeat(64)}:trusted`)
    assert.equal(
      (await collectRunArtifact(value.store, value.manifest.runId, "artifact")).sealed,
      true,
    )
    await value.store.invalidateFrom("deploy-ready")
    await assert.rejects(() => collectRunArtifact(value.store, value.manifest.runId, "artifact"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a hash-consistent but wrong-stage usage receipt cannot authorize checkpoint replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-receipt-"))
  try {
    const value = await fixture(root, "implementation")
    const receipt = JSON.stringify({ ...JSON.parse(value.usage), stage: "research-prd" })
    await atomicWriteStateFile(
      root,
      join(value.store.stateRoot, "evidence", value.usageRef),
      receipt,
    )
    const checkpoint = JSON.parse(await readFile(value.path, "utf8"))
    await atomicWriteStateFile(
      root,
      value.path,
      JSON.stringify({ ...checkpoint, usageHash: digest(receipt) }),
    )
    assert.equal(
      await validCheckpoint(value.store, value.path, {
        runId: value.manifest.runId,
        stage: "implementation",
        inputHash: value.inputHash,
      }),
      undefined,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
