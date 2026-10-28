import assert from "node:assert/strict"
import { readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"

import {
  persistRunnerAdapterReceipts,
  RUNNER_EVIDENCE_KINDS,
  RUNNER_RECEIPT_PREFIX,
  readRunnerAdapterReceipts,
  runnerReceiptLines,
} from "../../src/execution/runner-adapter-receipt"
import { ProjectStore } from "../../src/state/project-store"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
const STDOUT_HASH = "0".repeat(64)
afterEach(cleanup)

async function fixture() {
  const project = await trackedTempDirectory(join(tmpdir(), "runner-receipts-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  await persistRunnerAdapterReceipts(
    store,
    "web-next",
    RUNNER_EVIDENCE_KINDS.map((kind) => ({
      kind,
      argv: ["fixture-tool", kind],
      outcome: "passed" as const,
      exitCode: 0 as const,
      stdoutHash: STDOUT_HASH,
      report: { schemaVersion: 1, kind, verified: true },
    })),
  )
  return store
}

test("runner receipt channel emits nine strict JSON records", async () => {
  const store = await fixture()

  const lines = await runnerReceiptLines(store)

  assert.equal(lines.length, 9)
  for (const line of lines) {
    assert.ok(line.startsWith(RUNNER_RECEIPT_PREFIX))
    const receipt = JSON.parse(line.slice(RUNNER_RECEIPT_PREFIX.length))
    assert.deepEqual(Object.keys(receipt), [
      "schemaVersion",
      "adapterId",
      "kind",
      "argv",
      "outcome",
      "exitCode",
      "stdoutHash",
      "artifacts",
    ])
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.outcome, "passed")
  }
})

test("runner receipt reader rejects tampered reports", async () => {
  const store = await fixture()
  await writeFile(join(store.stateRoot, "adapter-evidence", "security.json"), '{"tampered":true}\n')

  await assert.rejects(readRunnerAdapterReceipts(store), /hash mismatch/i)
})

test("runner receipt reader rejects non-strict receipt JSON", async () => {
  const store = await fixture()
  const path = join(store.stateRoot, "evidence", "runner-adapter-receipts.jsonl")
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  records[0].unexpected = true
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

  await assert.rejects(readRunnerAdapterReceipts(store))
})

test("runner receipt reader rejects linked report artifacts", async () => {
  const store = await fixture()
  const report = join(store.stateRoot, "adapter-evidence", "security.json")
  const outside = join(store.projectRoot, "outside.json")
  await writeFile(outside, '{"linked":true}\n')
  await unlink(report)
  await symlink(outside, report)

  await assert.rejects(readRunnerAdapterReceipts(store), /regular file|escaped/i)
})

const argvCases = [
  { name: "1024 ASCII", argument: "x".repeat(1024), accepted: true },
  { name: "342 Hangul", argument: "가".repeat(342), accepted: true },
  { name: "1024 Hangul", argument: "가".repeat(1024), accepted: true },
  { name: "1024 astral scalars", argument: "😀".repeat(1024), accepted: true },
  { name: "1025 ASCII", argument: "x".repeat(1025), accepted: false },
  { name: "1025 Hangul", argument: "가".repeat(1025), accepted: false },
  { name: "1025 astral scalars", argument: "😀".repeat(1025), accepted: false },
] as const
for (const item of argvCases) {
  test(`runner receipt writer applies the shared code-point bound: ${item.name}`, async () => {
    const project = await trackedTempDirectory(join(tmpdir(), "runner-argv-bound-"))
    const store = new ProjectStore(project)
    await store.initialize("create", "2026-07-15T00:00:00.000Z")
    const result = persistRunnerAdapterReceipts(
      store,
      "web-next",
      RUNNER_EVIDENCE_KINDS.map((kind) => ({
        kind,
        argv: [item.argument],
        outcome: "passed" as const,
        exitCode: 0 as const,
        stdoutHash: STDOUT_HASH,
        report: { schemaVersion: 1, kind, verified: true },
      })),
    )

    if (item.accepted) await assert.doesNotReject(result)
    else await assert.rejects(result, /argv/i)
  })
}

test("runner receipt writer rejects a report path for a different evidence kind", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "runner-report-correlation-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")

  await assert.rejects(
    persistRunnerAdapterReceipts(
      store,
      "web-next",
      RUNNER_EVIDENCE_KINDS.map((kind) => ({
        kind,
        argv: ["fixture-tool", kind],
        outcome: "passed" as const,
        exitCode: 0 as const,
        stdoutHash: STDOUT_HASH,
        ...(kind === "security"
          ? { reportPath: ".app-harness/adapter-evidence/toolchain.json" }
          : { report: { schemaVersion: 1, kind } }),
      })),
    ),
    /correlated/i,
  )
})
