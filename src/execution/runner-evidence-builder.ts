import type {
  AdapterCommandReceipt,
  AdapterContext,
  AdapterResult,
  AppAdapter,
} from "../adapters/contract"
import type { RunManifest } from "../domain/manifest"
import type { ProjectStore } from "../state/project-store"
import { runInternalAuditWorker } from "./internal-audit-worker-client"
import {
  persistRunnerAdapterReceipts,
  type RunnerEvidenceDefinition,
} from "./runner-adapter-receipt"
import type { TrustedReceipt } from "./trusted-adapter-evidence"

export type VerifiedAdapterResults = {
  readonly build: AdapterResult
  readonly test: AdapterResult
  readonly manualQa: AdapterResult
  readonly packageDeployReady: AdapterResult
}

type SuccessfulCommandReceipt = Omit<AdapterCommandReceipt, "outcome" | "exitCode"> & {
  readonly outcome: "passed"
  readonly exitCode: 0
}

function receipt(
  result: AdapterResult,
  position: "first" | "last" = "last",
): SuccessfulCommandReceipt {
  const receipts = result.commandReceipts ?? []
  const receipt = position === "first" ? receipts[0] : receipts.at(-1)
  if (receipt === undefined || receipt.outcome !== "passed" || receipt.exitCode !== 0) {
    throw new Error("runner evidence lacks a successful correlated command receipt")
  }
  return { ...receipt, outcome: receipt.outcome, exitCode: receipt.exitCode }
}

function executed(receipt: SuccessfulCommandReceipt) {
  return {
    argv: [receipt.executable, ...receipt.args],
    outcome: receipt.outcome,
    exitCode: receipt.exitCode,
    stdoutHash: receipt.stdoutHash,
  }
}

function commandReport(result: AdapterResult): Readonly<Record<string, unknown>> {
  return {
    commands: result.commands,
    exitReceipts: result.commandReceipts,
    outputArtifacts: result.outputArtifacts ?? [],
    executedChecks: result.executedChecks ?? 0,
    accessibilityChecks: result.accessibilityChecks ?? 0,
  }
}

export async function buildAndPersistRunnerEvidence(
  store: ProjectStore,
  manifest: Readonly<RunManifest>,
  adapter: AppAdapter,
  results: VerifiedAdapterResults,
  trustedReceipts: readonly TrustedReceipt[],
  context: AdapterContext,
) {
  const outputs = results.packageDeployReady.outputArtifacts ?? []
  const base = { schemaVersion: 1, runId: manifest.runId, adapterId: adapter.id }
  const request = (
    kind: "accessibility" | "security" | "migrations" | "backup_restore" | "toolchain",
  ) =>
    runInternalAuditWorker({
      store,
      runId: manifest.runId,
      adapterId: adapter.id,
      kind,
      outputArtifacts: kind === "security" ? outputs : [],
      context,
    })
  const [accessibility, security, migrations, backupRestore, toolchain] = await Promise.all([
    request("accessibility"),
    request("security"),
    request("migrations"),
    request("backup_restore"),
    request("toolchain"),
  ])
  const definitions: RunnerEvidenceDefinition[] = [
    {
      kind: "production_build",
      ...executed(receipt(results.build)),
      report: { ...base, kind: "production_build", ...commandReport(results.build) },
    },
    {
      kind: "unit_integration_tests",
      ...executed(receipt(results.test)),
      report: { ...base, kind: "unit_integration_tests", ...commandReport(results.test) },
    },
    {
      kind: "manual_surface_qa",
      ...executed(receipt(results.manualQa)),
      report: { ...base, kind: "manual_surface_qa", ...commandReport(results.manualQa) },
    },
    accessibility,
    security,
    migrations,
    backupRestore,
    {
      kind: "release_bundle",
      ...executed(receipt(results.packageDeployReady)),
      report: {
        ...base,
        kind: "release_bundle",
        ...commandReport(results.packageDeployReady),
        trustedArtifactHashes: trustedReceipts.flatMap((receipt) => receipt.artifactHashes),
      },
    },
    toolchain,
  ]
  return persistRunnerAdapterReceipts(store, adapter.id, definitions)
}
