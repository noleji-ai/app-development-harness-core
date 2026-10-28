#!/usr/bin/env node

import { realpathSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { verifyOutputArtifacts } from "./adapters/adapter-output"
import { commandResult, runCommand } from "./adapters/command-runner"
import type { OfficialAdapterSpec } from "./adapters/official-types"
import { OFFICIAL_SPECS } from "./adapters/registry"
import { accessibilityAudit } from "./adapters/semantic-evidence"
import { backupRestoreAudit, migrationAudit, securityAudit } from "./execution/adapter-audit"
import {
  type AuditWorkerInput,
  AuditWorkerInputSchema,
  type AuditWorkerReport,
  AuditWorkerReportSchema,
  type InternalAuditKind,
} from "./execution/audit-worker-contract"
import { migrationApplyAudit } from "./execution/migration-apply-audit"
import { postgresqlBackupRestoreAudit } from "./execution/stateful-backup-restore"
import { atomicWriteStateFile } from "./state/atomic-state-file"
import { closeBoundStateWorkers } from "./state/bound-state-directory"
import { assertSafeStateDirectory, assertSafeStateFile } from "./state/safe-path"

type WorkerArguments = {
  readonly kind: InternalAuditKind
  readonly projectRoot: string
  readonly inputPath: string
  readonly outputPath: string
}

function contained(root: string, target: string): boolean {
  const route = relative(root, target)
  return route === "" || (route !== ".." && !route.startsWith(`..${sep}`))
}

function parseArguments(values: readonly string[]): WorkerArguments {
  if (
    values.length !== 8 ||
    values[0] !== "--kind" ||
    values[2] !== "--project" ||
    values[4] !== "--input" ||
    values[6] !== "--output"
  ) {
    throw new Error("invalid internal audit worker argv")
  }
  const parsedKind = AuditWorkerInputSchema.shape.kind.safeParse(values[1])
  if (!parsedKind.success) {
    throw new Error("invalid internal audit worker kind")
  }
  const kind = parsedKind.data
  const projectRoot = values[3]
  const inputPath = values[5]
  const outputPath = values[7]
  if (
    projectRoot === undefined ||
    inputPath === undefined ||
    outputPath === undefined ||
    isAbsolute(inputPath) ||
    isAbsolute(outputPath) ||
    [projectRoot, inputPath, outputPath].some((value) => value.includes("\0"))
  ) {
    throw new Error("unsafe internal audit worker path")
  }
  return { kind, projectRoot, inputPath, outputPath }
}

function specFor(adapterId: string): OfficialAdapterSpec {
  const matches = OFFICIAL_SPECS.filter((spec) => spec.id === adapterId)
  if (matches.length !== 1) throw new Error("internal audit worker adapter is unsupported")
  const spec = matches[0]
  if (spec === undefined) throw new Error("internal audit worker adapter is unsupported")
  return spec
}

function base(input: AuditWorkerInput) {
  return {
    schemaVersion: 1 as const,
    runId: input.runId,
    adapterId: input.adapterId,
    status: "passed" as const,
  }
}

async function toolchainReport(projectRoot: string, input: AuditWorkerInput) {
  const spec = specFor(input.adapterId)
  const executionEnvironment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") executionEnvironment[key] = value
  }
  const outcome = await runCommand(
    { projectRoot, mode: "create", requestedCapabilities: [], executionEnvironment },
    spec.probe,
  )
  const result = commandResult(outcome, `${spec.id} toolchain audit`, spec.probe)
  const receipt = result.commandReceipts?.[0]
  if (outcome.kind !== "passed" || receipt?.outcome !== "passed" || receipt.exitCode !== 0) {
    throw new Error(`toolchain audit failed: ${spec.probe.executable}`)
  }
  if (spec.probeOutput !== undefined && !outcome.stdout.includes(spec.probeOutput)) {
    throw new Error(`toolchain audit version mismatch: ${spec.probeOutput}`)
  }
  return {
    ...base(input),
    kind: "toolchain" as const,
    expected: spec.probeOutput ?? null,
    observed: outcome.stdout.trim(),
    commandReceipt: receipt,
  }
}

async function executeAudit(
  projectRoot: string,
  input: AuditWorkerInput,
): Promise<AuditWorkerReport> {
  const spec = specFor(input.adapterId)
  let report: unknown
  if (input.kind === "accessibility") {
    const audit = await accessibilityAudit(projectRoot, spec)
    if (spec.platform !== "backend" && audit.checks < 1)
      throw new Error("accessibility audit failed")
    report = {
      ...base(input),
      kind: input.kind,
      applicable: spec.platform !== "backend",
      ...audit,
    }
  } else if (input.kind === "security") {
    await verifyOutputArtifacts(projectRoot, input.outputArtifacts)
    const audit = await securityAudit(projectRoot, input.outputArtifacts)
    if (audit.findings.length > 0) throw new Error("security audit found embedded credentials")
    report = { ...base(input), kind: input.kind, ...audit }
  } else if (input.kind === "migrations") {
    const audit = await migrationAudit(projectRoot)
    const applied = await migrationApplyAudit(projectRoot, audit.migrations)
    report = {
      ...base(input),
      kind: input.kind,
      ...audit,
      application:
        applied === undefined
          ? {
              applicable: false as const,
              verifiedNotApplicable: true as const,
              rationale: "capability and schema scan found no migration files",
            }
          : { ...applied.audit, commandReceipt: applied.receipt },
    }
  } else if (input.kind === "backup_restore") {
    let details:
      | Awaited<ReturnType<typeof backupRestoreAudit>>
      | Awaited<ReturnType<typeof postgresqlBackupRestoreAudit>>
    switch (spec.persistence.kind) {
      case "stateless":
        details = await backupRestoreAudit(projectRoot)
        break
      case "postgresql":
        details = await postgresqlBackupRestoreAudit(projectRoot, spec.persistence)
        break
    }
    report = {
      ...base(input),
      kind: input.kind,
      details,
    }
  } else {
    report = await toolchainReport(projectRoot, input)
  }
  return AuditWorkerReportSchema.parse(report)
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const root = await realpath(resolve(args.projectRoot))
  const input = resolve(root, args.inputPath)
  const output = resolve(root, args.outputPath)
  const evidenceRoot = resolve(root, ".app-harness", "evidence")
  const reportRoot = resolve(root, ".app-harness", "adapter-evidence")
  if (!contained(evidenceRoot, input) || !contained(reportRoot, output)) {
    throw new Error("internal audit worker path escaped its evidence root")
  }
  await assertSafeStateFile(root, input)
  await assertSafeStateDirectory(root, reportRoot)
  const job = AuditWorkerInputSchema.parse(JSON.parse(await readFile(input, "utf8")))
  if (job.kind !== args.kind) throw new Error("internal audit worker job kind mismatch")
  const report = await executeAudit(root, job)
  await atomicWriteStateFile(root, output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ kind: report.kind, status: report.status })}\n`)
}

function isDirectInvocation(invokedPath: string | undefined, moduleUrl: string): boolean {
  return (
    invokedPath !== undefined &&
    realpathSync(invokedPath) === realpathSync(fileURLToPath(moduleUrl))
  )
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  // no-excuse-ok: catch — worker process boundary converts failures to stderr and a nonzero exit.
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
    .finally(closeBoundStateWorkers)
}
