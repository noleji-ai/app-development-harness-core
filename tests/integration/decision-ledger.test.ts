import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DecisionLedger, RevisionConflictError } from "../../src/state/decision-ledger"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

async function fixture() {
  const root = await trackedTempDirectory(join(tmpdir(), "app-ledger-"))
  await mkdir(join(root, ".app-harness/locks"), { recursive: true, mode: 0o700 })
  return { root, ledger: new DecisionLedger(root) }
}

const decision = {
  id: "gate-1",
  runId: "run-1",
  stage: "scope-approval",
  category: "product-scope",
  blocking: true,
  recommendation: "Approve the focused v1 scope.",
  alternatives: [
    { id: "focused", label: "Focused scope", score: 91, tradeoffs: "Fastest verified path" },
    { id: "broad", label: "Broad scope", score: 74, tradeoffs: "More time and risk" },
  ],
  businessImpact: "Controls delivery time and validation depth.",
  evidence: ["prd:v1"],
  actor: "harness",
  createdAt: "2026-07-13T00:00:00.000Z",
} as const

describe("append-only decision ledger", () => {
  test("restores approval and history after restart", async () => {
    const { root, ledger } = await fixture()
    const initial = await ledger.initialize(decision)
    const approved = await ledger.mutate({
      id: decision.id,
      runId: decision.runId,
      expectedRevision: initial.revision,
      action: "approve",
      selected: "focused",
      reason: "Best quality within the launch window.",
      actor: "user",
      idempotencyKey: "approve-gate-1",
      decidedAt: "2026-07-13T00:01:00.000Z",
    })
    const restarted = new DecisionLedger(root)
    expect((await restarted.list())[0]).toEqual(approved)
    expect(await restarted.history(decision.id, decision.runId)).toHaveLength(2)
  })

  test("serializes concurrent updates and rejects a stale revision", async () => {
    const { ledger } = await fixture()
    await ledger.initialize(decision)
    const update = (key: string) =>
      ledger.mutate({
        id: decision.id,
        runId: decision.runId,
        expectedRevision: 1,
        action: "approve",
        selected: "focused",
        reason: key,
        actor: "user",
        idempotencyKey: key.padEnd(8, "x"),
        decidedAt: "2026-07-13T00:01:00.000Z",
      })
    const results = await Promise.allSettled([update("first"), update("second")])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(RevisionConflictError)
  })

  test("makes retried idempotency keys a no-op", async () => {
    const { root, ledger } = await fixture()
    await ledger.initialize(decision)
    const mutation = {
      id: decision.id,
      runId: decision.runId,
      expectedRevision: 1,
      action: "comment",
      reason: "Keep this note.",
      actor: "user",
      idempotencyKey: "comment-0001",
      decidedAt: "2026-07-13T00:01:00.000Z",
    } as const
    const first = await ledger.mutate(mutation)
    const second = await ledger.mutate(mutation)
    expect(second).toEqual(first)
    const lines = (await readFile(join(root, ".app-harness/decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(lines).toHaveLength(2)
  })

  test("rejects an idempotency key reused for a different mutation meaning", async () => {
    // Given
    const { ledger } = await fixture()
    await ledger.initialize(decision)
    await ledger.mutate({
      id: decision.id,
      runId: decision.runId,
      expectedRevision: 1,
      action: "comment",
      reason: "Original note.",
      actor: "user",
      idempotencyKey: "meaning-0001",
      decidedAt: "2026-07-13T00:01:00.000Z",
    })

    // When / Then
    await expect(
      ledger.mutate({
        id: decision.id,
        runId: decision.runId,
        expectedRevision: 1,
        action: "comment",
        reason: "Different note.",
        actor: "user",
        idempotencyKey: "meaning-0001",
        decidedAt: "2026-07-13T00:01:00.000Z",
      }),
    ).rejects.toThrow(/idempotency/i)
  })

  test("rejects a globally reused idempotency key bound to another decision", async () => {
    // Given
    const { ledger } = await fixture()
    await ledger.initialize(decision)
    await ledger.initialize({ ...decision, id: "gate-2", stage: "design-selection" })
    await ledger.mutate({
      id: decision.id,
      runId: decision.runId,
      expectedRevision: 1,
      action: "comment",
      reason: "First decision note.",
      actor: "user",
      idempotencyKey: "global-key-0001",
      decidedAt: "2026-07-13T00:01:00.000Z",
    })

    // When / Then
    await expect(
      ledger.mutate({
        id: "gate-2",
        runId: decision.runId,
        expectedRevision: 1,
        action: "comment",
        reason: "Second decision note.",
        actor: "user",
        idempotencyKey: "global-key-0001",
        decidedAt: "2026-07-13T00:01:00.000Z",
      }),
    ).rejects.toThrow(/idempotency/i)
  })

  test("fails closed on a dead legacy lock instead of deleting a successor", async () => {
    // Given
    const { root, ledger } = await fixture()
    await writeFile(
      join(root, ".app-harness/locks/decisions.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00.000Z" })}\n`,
    )

    // When
    const initialization = ledger.initialize(decision)

    // Then
    await expect(initialization).rejects.toThrow(/recovery required.*doctor/i)
    expect(await readFile(join(root, ".app-harness/locks/decisions.lock"), "utf8")).toContain(
      "2147483647",
    )
  })

  test("fails closed on an expired legacy lock without owner metadata", async () => {
    // Given
    const { root, ledger } = await fixture()
    const lock = join(root, ".app-harness/locks/decisions.lock")
    await writeFile(lock, "")
    await utimes(lock, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"))

    // When
    const initialization = ledger.initialize(decision)

    // Then
    await expect(initialization).rejects.toThrow(/recovery required.*doctor/i)
    expect(await readFile(lock, "utf8")).toBe("")
  })

  test("recovers a stale UUID claim left by a crashed owner", async () => {
    // Given
    const { root, ledger } = await fixture()
    const token = "10000000-0000-4000-8000-000000000001"
    const staleClaim = join(root, `.app-harness/locks/.decisions.lock.${token}.claim`)
    await writeFile(
      staleClaim,
      `${JSON.stringify({
        pid: 2_147_483_647,
        createdAt: "2020-01-01T00:00:00.000Z",
        token,
        status: "held",
      })}\n`,
    )

    // When
    const initialized = await ledger.initialize(decision)

    // Then
    expect(initialized.id).toBe(decision.id)
    await expect(access(staleClaim)).rejects.toHaveProperty("code", "ENOENT")
  })

  test("does not steal an active lock even when its timestamp is old", async () => {
    // Given
    const { root, ledger } = await fixture()
    await writeFile(
      join(root, ".app-harness/locks/decisions.lock"),
      `${JSON.stringify({ pid: process.pid, createdAt: "2020-01-01T00:00:00.000Z" })}\n`,
    )

    // When / Then
    await expect(ledger.initialize(decision)).rejects.toThrow(/active/i)
  })

  test("blocks a tampered hash chain", async () => {
    const { root, ledger } = await fixture()
    await ledger.initialize(decision)
    const file = join(root, ".app-harness/decisions.jsonl")
    const value = await readFile(file, "utf8")
    await writeFile(file, value.replace("Approve the focused", "Approve any broad"))
    await expect(ledger.list()).rejects.toThrow("integrity")
  })

  test("blocks a symlinked ledger", async () => {
    const root = await trackedTempDirectory(join(tmpdir(), "app-ledger-link-"))
    const outside = join(root, "outside.jsonl")
    await writeFile(outside, "")
    await mkdir(join(root, ".app-harness/locks"), { recursive: true })
    await symlink(outside, join(root, ".app-harness/decisions.jsonl"))
    await expect(new DecisionLedger(root).initialize(decision)).rejects.toThrow("symlink")
  })
})
