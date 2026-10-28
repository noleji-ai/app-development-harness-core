import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { executeCli, isDirectInvocation, PUBLIC_COMMANDS } from "../../src/cli.js"
import { closeBoundStateWorkers } from "../../src/state/bound-state-directory"
import { DecisionLedger } from "../../src/state/decision-ledger"
import { ProjectStore } from "../../src/state/project-store"
import { createGateCodexFixture } from "../support/gate-codex-fixture"
import { createTempDirectoryTracker } from "../support/temp-directory"

const { cleanup, create: trackedTempDirectory } = createTempDirectoryTracker()
afterEach(async () => {
  await closeBoundStateWorkers()
  cleanup()
})

test("CLI publishes all eight commands", () => {
  assert.deepEqual(PUBLIC_COMMANDS, [
    "init",
    "run",
    "resume",
    "status",
    "verify",
    "dashboard",
    "doctor",
    "upgrade",
  ])
})

test("CLI help preserves exactly the eight public commands", async () => {
  // Given
  const output: string[] = []

  // When
  await executeCli(["--help"], {
    stdout: (value) => output.push(value),
    stderr: () => undefined,
  })

  // Then
  const commandLines = (output[0] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim())
  assert.deepEqual(commandLines, PUBLIC_COMMANDS)
})

test("CLI recognizes direct invocation through a symlinked macOS path", async () => {
  // Given
  const root = await trackedTempDirectory(join(tmpdir(), "app-harness-entrypoint-"))
  const realDirectory = join(root, "real")
  const aliasDirectory = join(root, "alias")
  await mkdir(realDirectory)
  await writeFile(join(realDirectory, "cli.js"), "#!/usr/bin/env node\n")
  await symlink(realDirectory, aliasDirectory)

  // When
  const direct = isDirectInvocation(
    join(aliasDirectory, "cli.js"),
    pathToFileURL(join(realDirectory, "cli.js")).href,
  )

  // Then
  assert.equal(direct, true)
})

test("init creates the project state contract and is idempotent", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-"))
  const output: string[] = []
  await executeCli(["init", "--project", project, "--mode", "create"], {
    stdout: (value) => output.push(value),
    stderr: () => undefined,
  })
  await executeCli(["init", "--project", project, "--mode", "create"], {
    stdout: () => undefined,
    stderr: () => undefined,
  })
  const config = JSON.parse(await readFile(join(project, ".app-harness/config.json"), "utf8"))
  const lock = JSON.parse(await readFile(join(project, ".app-harness/harness.lock.json"), "utf8"))
  assert.equal(config.mode, "create")
  assert.equal(config.workflowProfileDefault, "lean")
  assert.equal(config.harnessVersion, "1.2.0")
  assert.equal(lock.schemaVersion, 2)
  assert.equal(lock.lockProtocolVersion, 2)
  assert.match(output[0] ?? "", /initialized/)
})

test("run snapshots an explicit workflow profile only at creation", async () => {
  // Given: a new project whose persisted default is lean.
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-workflow-profile-"))
  const io = { stdout: () => undefined, stderr: () => undefined }

  // When: the run opts into full execution at creation time.
  await executeCli(
    ["run", "--project", project, "--workflow-profile", "full", "--request", "Build a focused app"],
    io,
    {
      executeStage: async () => ({ kind: "blocked", decisionIds: ["creation-stop"] }),
      runId: () => "run-full-snapshot",
      now: () => "2026-07-15T00:00:00.000Z",
    },
  )

  // Then: the manifest keeps the creation-time override independent of the project default.
  const store = new ProjectStore(project)
  const config = await store.readConfig()
  const manifest = await store.loadManifest("run-full-snapshot")
  assert.equal(config.workflowProfileDefault, "lean")
  assert.equal(manifest.workflowProfile, "full")
})

test("doctor identifies protocol metadata that must be upgraded", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-upgrade-"))
  const output: string[] = []
  const io = { stdout: (value: string) => output.push(value), stderr: () => undefined }
  await executeCli(["init", "--project", project], io)
  await writeFile(
    join(project, ".app-harness/harness.lock.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "1.0.0",
      registryVersion: "v1",
      technologies: {},
    })}\n`,
  )

  // When
  await executeCli(["doctor", "--project", project], io)
  const before = JSON.parse(output.at(-1) ?? "{}")
  await executeCli(["upgrade", "--project", project], io)
  const upgraded = JSON.parse(output.at(-1) ?? "{}")
  await executeCli(["doctor", "--project", project], io)
  const after = JSON.parse(output.at(-1) ?? "{}")

  // Then
  assert.equal(before.ok, false)
  assert.equal(before.lockProtocol.status, "upgrade-required")
  assert.equal(upgraded.status, "upgraded")
  assert.equal(upgraded.lockProtocol.status, "compatible")
  assert.equal(after.ok, true)
  assert.equal(after.lockProtocol.version, 2)
})

test("doctor and upgrade report a dead legacy lock as recovery-required", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-recovery-"))
  const output: string[] = []
  const io = { stdout: (value: string) => output.push(value), stderr: () => undefined }
  await executeCli(["init", "--project", project], io)
  const base = join(project, ".app-harness/locks/decisions.lock")
  await writeFile(
    base,
    `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2020-01-01T00:00:00.000Z" })}\n`,
  )

  // When
  await executeCli(["doctor", "--project", project], io)
  const diagnosis = JSON.parse(output.at(-1) ?? "{}")
  await executeCli(["upgrade", "--project", project], io)
  const upgrade = JSON.parse(output.at(-1) ?? "{}")

  // Then
  assert.equal(diagnosis.ok, false)
  assert.equal(diagnosis.lockProtocol.status, "recovery-required")
  assert.match(diagnosis.lockProtocol.blockers[0].remediation, /automatic removal is unsafe/i)
  assert.equal(upgrade.status, "blocked")
  assert.equal(upgrade.lockProtocol.status, "recovery-required")
  assert.match(await readFile(base, "utf8"), /2147483647/)
})

test("upgrade stays blocked until an active previous client safely releases", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-active-legacy-"))
  const output: string[] = []
  const io = { stdout: (value: string) => output.push(value), stderr: () => undefined }
  await executeCli(["init", "--project", project], io)
  const base = join(project, ".app-harness/locks/decisions.lock")
  await writeFile(
    base,
    `${JSON.stringify({ pid: process.pid, createdAt: "2026-07-14T00:00:00.000Z" })}\n`,
  )

  // When / Then: no wait and no unsafe removal while the old owner is active.
  await executeCli(["doctor", "--project", project], io)
  const diagnosis = JSON.parse(output.at(-1) ?? "{}")
  await executeCli(["upgrade", "--project", project], io)
  const blocked = JSON.parse(output.at(-1) ?? "{}")
  assert.equal(diagnosis.lockProtocol.status, "active-legacy-lock")
  assert.equal(blocked.status, "blocked")
  assert.match(await readFile(base, "utf8"), new RegExp(String(process.pid)))

  // When / Then: the next upgrade succeeds after the previous client releases normally.
  await unlink(base)
  await executeCli(["upgrade", "--project", project], io)
  const upgraded = JSON.parse(output.at(-1) ?? "{}")
  assert.equal(upgraded.status, "upgraded")
  assert.equal(upgraded.lockProtocol.status, "compatible")
})

test("unknown commands fail without invoking a shell or deployment", async () => {
  await assert.rejects(
    () => executeCli(["deploy"], { stdout: () => undefined, stderr: () => undefined }),
    /Unknown command/,
  )
})

test("hook user-prompt-submit emits only advisory routing", async () => {
  const output: string[] = []
  await executeCli(["hook", "user-prompt-submit", "Build a new web app from scratch"], {
    stdout: (value) => output.push(value),
    stderr: () => undefined,
  })
  const result = JSON.parse(output[0] ?? "{}")
  assert.equal(result.matched, true)
})

test("run and resume persist both mandatory gates in the ledger", async () => {
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-gates-"))
  const codexBinary = await createGateCodexFixture(project)
  const diagnostic: string[] = []
  const io = { stdout: (value: string) => diagnostic.push(value), stderr: () => undefined }
  await executeCli(
    [
      "run",
      "--project",
      project,
      "--workflow-profile",
      "full",
      "--request",
      "Build a focused offline notes app",
    ],
    io,
    { codexBinary, runId: () => "run-gates", now: () => "2026-07-13T00:00:00.000Z" },
  )
  const ledger = new DecisionLedger(project)
  const first = (await ledger.list())[0]
  assert.equal(first?.id, "gate-1-prd-scope", diagnostic.join("\n"))
  await ledger.mutate({
    id: "gate-1-prd-scope",
    runId: "run-gates",
    expectedRevision: 1,
    action: "approve",
    selected: "focused-v1",
    reason: "Proceed with the recommended scope.",
    actor: "user",
    idempotencyKey: "approve-scope-01",
    decidedAt: "2026-07-13T00:01:00.000Z",
  })
  await executeCli(["resume", "--project", project], io, {
    codexBinary,
    now: () => "2026-07-13T00:02:00.000Z",
  })
  const decisions = await ledger.list()
  assert.equal(
    decisions.find((decision) => decision.id === "gate-2-design-direction")?.status,
    "pending",
  )
})

test("run accepts a contained UTF-8 request file", async () => {
  // Given
  const project = await trackedTempDirectory(join(tmpdir(), "app-harness-request-file-"))
  const codexBinary = await createGateCodexFixture(project)
  const request = "Build an offline-first Korean study planner.\n"
  await writeFile(join(project, "product-request.md"), request)

  // When
  await executeCli(
    ["run", "--project", project, "--request-file", "product-request.md"],
    { stdout: () => undefined, stderr: () => undefined },
    {
      codexBinary,
      runId: () => "run-request-file",
      now: () => "2026-07-14T00:00:00.000Z",
    },
  )

  // Then
  const manifest = await new ProjectStore(project).loadManifest("run-request-file")
  assert.equal(manifest.request, request.trim())
})
