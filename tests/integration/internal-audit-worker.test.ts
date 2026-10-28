import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AuditWorkerReportSchema } from "../../src/execution/audit-worker-contract"
import { ProjectStore } from "../../src/state/project-store"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
const WORKER = fileURLToPath(new URL("../../src/internal-audit-worker.ts", import.meta.url))
afterEach(cleanup)

test("backup report boundary rejects a credentialed PostgreSQL argv", () => {
  // Given
  const hash = "a".repeat(64)
  const receipt = {
    executable: "psql",
    args: ["postgresql://사용자:p%40ss%F0%9F%94%90@example.invalid/service"],
    outcome: "passed",
    exitCode: 0,
    stdoutHash: hash,
  } as const

  // When / Then
  expect(() =>
    AuditWorkerReportSchema.parse({
      schemaVersion: 1,
      runId: "run-redaction-boundary",
      adapterId: "backend-go-postgres",
      status: "passed",
      kind: "backup_restore",
      details: {
        mode: "stateful",
        contract: "postgresql",
        bytes: 1,
        snapshotSha256: hash,
        originalSha256: hash,
        mutatedSha256: "b".repeat(64),
        restoredSha256: hash,
        matched: true,
        commandReceipts: Array.from({ length: 6 }, () => receipt),
      },
    }),
  ).toThrow(/database URLs must be redacted/i)
})

test("internal audit worker rejects parent-computed self-attestation fields", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "audit-worker-self-attest-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  await mkdir(join(store.stateRoot, "adapter-evidence"))
  const inputRoute = ".app-harness/evidence/audit-worker-security.json"
  const outputRoute = ".app-harness/adapter-evidence/security.json"
  await writeFile(
    join(project, inputRoute),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-self-attest",
      adapterId: "web-next",
      kind: "security",
      outputArtifacts: [],
      ok: true,
      facts: 999,
    })}\n`,
  )

  const child = Bun.spawn(
    [
      process.execPath,
      WORKER,
      "--kind",
      "security",
      "--project",
      project,
      "--input",
      inputRoute,
      "--output",
      outputRoute,
    ],
    { cwd: project, stderr: "pipe", stdout: "pipe" },
  )

  expect(await child.exited).not.toBe(0)
  expect(await new Response(child.stderr).text()).toMatch(/unrecognized|ok|facts/i)
  await expect(readFile(join(project, outputRoute), "utf8")).rejects.toHaveProperty(
    "code",
    "ENOENT",
  )
})

test("stateless backup proof fails when the worker discovers project state indicators", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-worker-state-indicator-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  await mkdir(join(store.stateRoot, "adapter-evidence"))
  await writeFile(join(project, ".env.example"), "DATABASE_URL=postgresql://localhost/app\n")
  const inputRoute = ".app-harness/evidence/audit-worker-backup_restore.json"
  const outputRoute = ".app-harness/adapter-evidence/backup_restore.json"
  await writeFile(
    join(project, inputRoute),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-state-indicator",
      adapterId: "web-next",
      kind: "backup_restore",
      outputArtifacts: [],
    })}\n`,
  )

  // When
  const child = Bun.spawn(
    [
      process.execPath,
      WORKER,
      "--kind",
      "backup_restore",
      "--project",
      project,
      "--input",
      inputRoute,
      "--output",
      outputRoute,
    ],
    { cwd: project, stderr: "pipe", stdout: "pipe" },
  )

  // Then
  expect(await child.exited).not.toBe(0)
  expect(await new Response(child.stderr).text()).toMatch(/stateful.*contract/i)
})

test("stateful backup proof requires an explicitly disposable database contract", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "audit-worker-database-contract-"))
  const store = new ProjectStore(project)
  await store.initialize("create", "2026-07-15T00:00:00.000Z")
  await mkdir(join(store.stateRoot, "adapter-evidence"))
  const inputRoute = ".app-harness/evidence/audit-worker-backup_restore.json"
  const outputRoute = ".app-harness/adapter-evidence/backup_restore.json"
  await writeFile(
    join(project, inputRoute),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-database-contract",
      adapterId: "backend-go-postgres",
      kind: "backup_restore",
      outputArtifacts: [],
    })}\n`,
  )

  // When
  const inheritedPath = Reflect.get(process.env, "PATH")
  const child = Bun.spawn(
    [
      process.execPath,
      WORKER,
      "--kind",
      "backup_restore",
      "--project",
      project,
      "--input",
      inputRoute,
      "--output",
      outputRoute,
    ],
    {
      cwd: project,
      env: { PATH: typeof inheritedPath === "string" ? inheritedPath : "" },
      stderr: "pipe",
      stdout: "pipe",
    },
  )

  // Then
  expect(await child.exited).not.toBe(0)
  expect(await new Response(child.stderr).text()).toMatch(
    /APP_HARNESS_BACKUP_DATABASE_URL.*DISPOSABLE/i,
  )
})
