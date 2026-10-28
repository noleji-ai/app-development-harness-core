import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { basename, delimiter, dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { AdapterContext, AdapterOutputArtifact } from "../adapters/contract"
import { atomicWriteStateFile } from "../state/atomic-state-file"
import { createBoundStateDirectory } from "../state/bound-state-directory"
import type { ProjectStore } from "../state/project-store"
import { assertSafeStateDirectory, assertSafeStateFile } from "../state/safe-path"
import { AuditWorkerReportSchema, type InternalAuditKind } from "./audit-worker-contract"
import type { RunnerEvidenceDefinition } from "./runner-adapter-receipt"

const WorkerSummarySchema = z
  .object({ kind: z.string().min(1), status: z.literal("passed") })
  .strict()

type AuditWorkerRequest = {
  readonly store: ProjectStore
  readonly runId: string
  readonly adapterId: string
  readonly kind: InternalAuditKind
  readonly outputArtifacts: readonly AdapterOutputArtifact[]
  readonly context: AdapterContext
}

function workerModulePath(): string {
  const current = fileURLToPath(import.meta.url)
  return basename(current) === "cli.js"
    ? join(dirname(current), "internal-audit-worker.js")
    : join(dirname(current), "..", "internal-audit-worker.ts")
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function alreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

async function ensureReportRoot(store: ProjectStore): Promise<void> {
  const root = join(store.stateRoot, "adapter-evidence")
  try {
    const state = await lstat(root)
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("unsafe audit report root")
  } catch (error) {
    if (!missing(error)) throw error
    try {
      await createBoundStateDirectory(store.projectRoot, root)
    } catch (createError) {
      if (!alreadyExists(createError)) throw createError
    }
  }
  await assertSafeStateDirectory(store.projectRoot, root)
}

async function executeWorker(
  executable: string,
  args: readonly string[],
  context: AdapterContext,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const configuredPath = context.toolchainPath
  const environmentPath = Reflect.get(process.env, "PATH")
  const inheritedPath = typeof environmentPath === "string" ? environmentPath : ""
  const path =
    configuredPath === undefined ? inheritedPath : `${configuredPath}${delimiter}${inheritedPath}`
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd: context.projectRoot,
      env: { ...context.executionEnvironment, PATH: path },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (exitCode) => {
      if (exitCode === null) reject(new Error("internal audit worker exited without a status"))
      else
        resolveResult({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        })
    })
  })
}

function validateReport(
  request: AuditWorkerRequest,
  value: unknown,
): ReturnType<typeof AuditWorkerReportSchema.parse> {
  const report = AuditWorkerReportSchema.parse(value)
  if (
    report.runId !== request.runId ||
    report.adapterId !== request.adapterId ||
    report.kind !== request.kind
  ) {
    throw new Error("internal audit worker report correlation mismatch")
  }
  if (report.kind === "security" && report.findings.length > 0) {
    throw new Error("internal audit worker security report failed")
  }
  if (
    report.kind === "backup_restore" &&
    report.details.mode === "stateful" &&
    report.details.originalSha256 !== report.details.restoredSha256
  ) {
    throw new Error("internal audit worker backup report mismatch")
  }
  if (
    report.kind === "migrations" &&
    report.application.applicable &&
    report.application.integrity !== "ok"
  ) {
    throw new Error("internal audit worker migration report failed")
  }
  return report
}

export async function runInternalAuditWorker(
  request: AuditWorkerRequest,
): Promise<RunnerEvidenceDefinition> {
  await ensureReportRoot(request.store)
  const inputRoute = join(".app-harness", "evidence", `audit-worker-${request.kind}.json`)
  const outputRoute = join(".app-harness", "adapter-evidence", `${request.kind}.json`)
  await atomicWriteStateFile(
    request.store.projectRoot,
    join(request.store.projectRoot, inputRoute),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: request.runId,
      adapterId: request.adapterId,
      kind: request.kind,
      outputArtifacts: request.outputArtifacts,
    })}\n`,
  )
  const module = workerModulePath()
  const args = [
    module,
    "--kind",
    request.kind,
    "--project",
    request.store.projectRoot,
    "--input",
    inputRoute.split(sep).join("/"),
    "--output",
    outputRoute.split(sep).join("/"),
  ] as const
  const executed = await executeWorker(process.execPath, args, request.context)
  if (executed.exitCode !== 0) {
    throw new Error(`internal audit worker failed (${executed.exitCode}): ${executed.stderr}`)
  }
  const summary = WorkerSummarySchema.parse(JSON.parse(executed.stdout))
  if (summary.kind !== request.kind) throw new Error("internal audit worker stdout mismatch")
  const outputPath = join(request.store.projectRoot, outputRoute)
  await assertSafeStateFile(request.store.projectRoot, outputPath)
  validateReport(request, JSON.parse(await readFile(outputPath, "utf8")))
  return {
    kind: request.kind,
    argv: [process.execPath, ...args],
    outcome: "passed",
    exitCode: executed.exitCode,
    stdoutHash: createHash("sha256").update(executed.stdout).digest("hex"),
    reportPath: relative(request.store.projectRoot, outputPath).split(sep).join("/"),
  }
}
