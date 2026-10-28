import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { executeCli } from "../../src/cli/commands"
import {
  backupRestoreAudit,
  migrationAudit,
  securityAudit,
} from "../../src/execution/adapter-audit"
import { DecisionLedger } from "../../src/state/decision-ledger"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(cleanup)

const gate = (runId: string) =>
  ({
    id: "gate-1-prd-scope",
    runId,
    stage: "scope-approval",
    category: "product-scope",
    blocking: true,
    recommendation: "Approve the focused scope.",
    alternatives: [{ id: "focused", label: "Focused", score: 91, tradeoffs: "Faster proof" }],
    businessImpact: "Controls delivery risk.",
    evidence: ["prd:v1"],
    actor: "harness",
    createdAt: "2026-07-15T00:00:00.000Z",
  }) as const

test("gate approvals and revisions are isolated to the exact run", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "run-scoped-gates-"))
  await mkdir(join(project, ".app-harness/locks"), { recursive: true })
  const ledger = new DecisionLedger(project)
  const first = await ledger.initialize(gate("run-a"))
  await ledger.mutate({
    id: first.id,
    runId: "run-a",
    expectedRevision: 1,
    action: "approve",
    selected: "focused",
    reason: "Run A choice.",
    actor: "user",
    idempotencyKey: "run-a-approval",
    decidedAt: "2026-07-15T00:01:00.000Z",
  })

  // When
  const second = await ledger.initialize(gate("run-b"))
  await ledger.mutate({
    id: second.id,
    runId: "run-b",
    expectedRevision: 1,
    action: "request_revision",
    reason: "Run B needs a narrower scope.",
    actor: "user",
    idempotencyKey: "run-b-revision",
    decidedAt: "2026-07-15T00:02:00.000Z",
  })

  // Then
  expect((await ledger.listRun("run-a"))[0]?.status).toBe("approved")
  expect((await ledger.listRun("run-b"))[0]?.status).toBe("revision_requested")
  expect(await ledger.history(first.id, "run-a")).toHaveLength(2)
  expect(await ledger.history(second.id, "run-b")).toHaveLength(2)
})

test("an explicit documented skip policy bypasses both mandatory design stages", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "design-policy-skip-"))
  const executed: string[] = []

  // When
  await executeCli(
    [
      "run",
      "--project",
      project,
      "--request",
      "Build a headless import worker with no user interface.",
      "--design-policy",
      "skip",
      "--design-policy-reason",
      "There is no human-facing surface; API and operations contracts are the product experience.",
    ],
    { stdout: () => undefined, stderr: () => undefined },
    {
      runId: () => "run-headless",
      now: () => "2026-07-15T00:00:00.000Z",
      executeStage: async (stage) => {
        executed.push(stage)
        return { kind: "completed", outputHash: stage, evidenceIds: [`stage:${stage}`] }
      },
    },
  )

  // Then
  expect(executed).not.toContain("design-candidates")
  expect(executed).not.toContain("design-selection")
})

test("security audit scans beyond 500 source files instead of silently truncating", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-all-files-"))
  for (let index = 0; index < 505; index += 1) {
    await writeFile(
      join(project, `${String(index).padStart(4, "0")}.ts`),
      "export const safe = true\n",
    )
  }
  await mkdir(join(project, "node_modules/dependency"), { recursive: true })
  await mkdir(join(project, "dist/assets"), { recursive: true })
  await writeFile(join(project, "node_modules/dependency/secret.ts"), "AKIA0000000000000000\n")
  await writeFile(join(project, "dist/assets/secret.js"), "AKIA0000000000000000\n")
  await writeFile(join(project, "zz-secret.ts"), "export const key = 'AKIA1234567890ABCDEF'\n")

  // When
  const report = await securityAudit(project, [])

  // Then
  expect(report.filesScanned).toBe(506)
  expect(report.findings).toEqual(["zz-secret.ts"])
})

test("security audit scans trusted packaged artifacts inside excluded output roots", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-packaged-secret-"))
  const path = join(project, "dist/release.bundle")
  const contents = Buffer.from("compiled payload: sk-live-0123456789abcdef\n")
  await mkdir(join(project, "dist"), { recursive: true })
  await writeFile(path, contents)

  // When
  const report = await securityAudit(project, [
    {
      path: "dist/release.bundle",
      sha256: createHash("sha256").update(contents).digest("hex"),
      size: contents.byteLength,
    },
  ])

  // Then
  expect(report.findings).toEqual(["dist/release.bundle"])
  expect(report.fileHashes.map((file) => file.path)).toContain("dist/release.bundle")
})

test("security audit rejects a linked packaged artifact instead of traversing it", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-linked-package-"))
  const outside = await trackedTempDirectory(join(tmpdir(), "audit-linked-secret-"))
  const contents = Buffer.from("sk-live-0123456789abcdef\n")
  await mkdir(join(project, "dist"), { recursive: true })
  await writeFile(join(outside, "release.bundle"), contents)
  await symlink(join(outside, "release.bundle"), join(project, "dist/release.bundle"))

  // When / Then
  await expect(
    securityAudit(project, [
      {
        path: "dist/release.bundle",
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength,
      },
    ]),
  ).rejects.toThrow(/regular file|symbolic link|escaped/i)
})

test("migration audit finds nested app migrations but excludes dependency and build trees", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-nested-migrations-"))
  await mkdir(join(project, "services/api/db/migrations"), { recursive: true })
  await mkdir(join(project, "node_modules/pkg/migrations"), { recursive: true })
  await mkdir(join(project, "dist/migrations"), { recursive: true })
  await writeFile(
    join(project, "services/api/db/migrations/0001.sql"),
    "CREATE TABLE app_state(id INT);\n",
  )
  await writeFile(
    join(project, "node_modules/pkg/migrations/0002.sql"),
    "CREATE TABLE dependency(id INT);\n",
  )
  await writeFile(join(project, "dist/migrations/0003.sql"), "CREATE TABLE built(id INT);\n")

  // When
  const report = await migrationAudit(project)

  // Then
  expect(report.migrations.map((item) => item.path)).toEqual([
    "services/api/db/migrations/0001.sql",
  ])
})

test("backup audit refuses generic stateless theater when project state indicators exist", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-stateful-contract-"))
  await writeFile(join(project, ".env.example"), "DATABASE_URL=postgresql://localhost/app\n")

  // When / Then
  await expect(backupRestoreAudit(project)).rejects.toThrow(/stateful|contract/i)
})
