import type { AdapterContext, AdapterResult, AppAdapter } from "../adapters/contract"
import { ADAPTERS } from "../adapters/registry"
import type { PipelineStage, RunManifest } from "../domain/manifest"
import type { StageResult } from "../engine/pipeline"
import type { VerificationCheck } from "../release/readiness"
import type { ProjectStore } from "../state/project-store"
import { buildAndPersistRunnerEvidence } from "./runner-evidence-builder"
import {
  createReceipt,
  createSecurityReceipt,
  persistTrustedEvidence,
  readinessCheck,
  releaseArtifactHash,
  type TrustedReceipt,
  trustedDigest,
} from "./trusted-adapter-evidence"

export interface TrustedAdapterExecutorOptions {
  readonly store: ProjectStore
  readonly adapters?: readonly AppAdapter[]
  readonly toolchainPath?: string
  readonly executionEnvironment?: Readonly<Record<string, string>>
}

export interface TrustedAdapterSession {
  execute(stage: PipelineStage, manifest: Readonly<RunManifest>): Promise<StageResult>
  readinessChecks(): readonly VerificationCheck[]
}

type VerifiedResults = {
  readonly build: AdapterResult
  readonly test: AdapterResult
  readonly manualQa: AdapterResult
}

type VerificationRun = {
  readonly receipts: readonly TrustedReceipt[]
  readonly results: VerifiedResults
}

type ReusableVerification = VerificationRun & {
  readonly stableKey: string
  readonly generation: number
}

function adapterContext(
  options: TrustedAdapterExecutorOptions,
  manifest: Readonly<RunManifest>,
): AdapterContext {
  const environmentPath = Reflect.get(process.env, "APP_HARNESS_ADAPTER_TOOLCHAIN_PATH")
  const configuredPath =
    options.toolchainPath ?? (typeof environmentPath === "string" ? environmentPath : undefined)
  return {
    projectRoot: options.store.projectRoot,
    mode: manifest.mode,
    requestedCapabilities: ["build", "test", "manual-qa", "deploy-ready"],
    ...(configuredPath === undefined ? {} : { toolchainPath: configuredPath }),
    ...(options.executionEnvironment === undefined
      ? {}
      : { executionEnvironment: options.executionEnvironment }),
  }
}

function checkId(receipt: TrustedReceipt): string {
  return receipt.operation === "manualQa" ? "manual-qa" : receipt.operation
}

function implementationOutputIdentity(manifest: Readonly<RunManifest>): string {
  const implementation = manifest.stages.implementation
  return implementation.kind === "completed" ? implementation.outputHash : implementation.kind
}

function verificationInputIdentity(manifest: Readonly<RunManifest>): string {
  const verification = manifest.stages.verification
  return "inputHash" in verification ? verification.inputHash : verification.kind
}

function contextIdentity(context: AdapterContext): string {
  return trustedDigest({
    toolchainPath: context.toolchainPath ?? null,
    executionEnvironment: context.executionEnvironment ?? {},
  })
}

function stableReuseKey(
  manifest: Readonly<RunManifest>,
  adapter: AppAdapter,
  context: AdapterContext,
): string {
  return trustedDigest({
    runId: manifest.runId,
    manifestInput: {
      mode: manifest.mode,
      workflowProfile: manifest.workflowProfile,
      request: manifest.request,
      designPolicy: manifest.designPolicy,
      verificationInput: verificationInputIdentity(manifest),
    },
    adapterId: adapter.id,
    implementationOutput: implementationOutputIdentity(manifest),
    trustedContext: contextIdentity(context),
  })
}

async function runVerification(
  manifest: Readonly<RunManifest>,
  adapter: AppAdapter,
  context: AdapterContext,
): Promise<{
  receipts: TrustedReceipt[]
  results: Partial<Record<"build" | "test" | "manualQa", AdapterResult>>
  failure?: string
}> {
  const receipts: TrustedReceipt[] = []
  const results: Partial<Record<"build" | "test" | "manualQa", AdapterResult>> = {}
  for (const operation of ["build", "test", "manualQa"] as const) {
    const result = await adapter[operation](context)
    results[operation] = result
    const receipt = createReceipt(manifest, adapter, operation, result)
    receipts.push(receipt)
    if (receipt.status !== "passed") return { receipts, results, failure: `adapter-${operation}` }
  }
  return { receipts, results }
}

async function saveVerification(
  store: ProjectStore,
  receipts: readonly TrustedReceipt[],
): Promise<readonly VerificationCheck[]> {
  const checks = receipts.map((receipt) => readinessCheck(checkId(receipt), receipt))
  await persistTrustedEvidence(store, receipts, checks)
  return checks
}

function verified(
  receipts: readonly TrustedReceipt[],
  results: Partial<Record<"build" | "test" | "manualQa", AdapterResult>>,
): VerificationRun {
  const build = results.build
  const test = results.test
  const manualQa = results.manualQa
  if (build === undefined || test === undefined || manualQa === undefined) {
    throw new Error("trusted adapter verification result set is incomplete")
  }
  return { receipts, results: { build, test, manualQa } }
}

function completed(receipts: readonly TrustedReceipt[]): StageResult {
  return {
    kind: "completed",
    outputHash: trustedDigest(receipts),
    evidenceIds: receipts.map((receipt) => `adapter-receipt:${receipt.receiptHash}`),
  }
}

export function createTrustedAdapterSession(
  options: TrustedAdapterExecutorOptions,
): TrustedAdapterSession {
  let currentChecks: readonly VerificationCheck[] = []
  let reusableVerification: ReusableVerification | undefined
  const execute = async (
    stage: PipelineStage,
    manifest: Readonly<RunManifest>,
  ): Promise<StageResult> => {
    currentChecks = []
    if (stage !== "verification" && stage !== "deploy-ready") {
      throw new Error(`trusted adapter executor does not own stage: ${stage}`)
    }
    if (manifest.adapterId === null) {
      return { kind: "unverified", missingCapabilities: ["selected-adapter"] }
    }
    const matches = (options.adapters ?? ADAPTERS).filter((item) => item.id === manifest.adapterId)
    if (matches.length !== 1) {
      return { kind: "unverified", missingCapabilities: ["supported-adapter"] }
    }
    const adapter = matches[0]
    if (adapter === undefined)
      return { kind: "unverified", missingCapabilities: ["supported-adapter"] }
    const context = adapterContext(options, manifest)
    const stableKey = stableReuseKey(manifest, adapter, context)
    try {
      const generationMatches =
        reusableVerification !== undefined &&
        (manifest.generation === reusableVerification.generation ||
          manifest.generation === reusableVerification.generation + 2)
      const reusable =
        stage === "deploy-ready" &&
        reusableVerification !== undefined &&
        reusableVerification.stableKey === stableKey &&
        generationMatches
          ? reusableVerification
          : undefined
      const verification = await (reusable ??
        (async (): Promise<
          | VerificationRun
          | { readonly failure: string; readonly receipts: readonly TrustedReceipt[] }
        > => {
          const fresh = await runVerification(manifest, adapter, context)
          if (fresh.failure !== undefined) {
            return { failure: fresh.failure, receipts: fresh.receipts }
          }
          return verified(fresh.receipts, fresh.results)
        })())
      if ("failure" in verification) {
        reusableVerification = undefined
        currentChecks = await saveVerification(options.store, verification.receipts)
        return { kind: "unverified", missingCapabilities: [verification.failure] }
      }
      if (stage === "verification") {
        reusableVerification = { ...verification, stableKey, generation: manifest.generation }
        currentChecks = await saveVerification(options.store, verification.receipts)
        return completed(verification.receipts)
      }
      const result = await adapter.packageDeployReady(context)
      const artifactHash =
        result.status === "passed"
          ? await releaseArtifactHash(options.store.projectRoot, adapter.id)
          : undefined
      const packaged = createReceipt(
        manifest,
        adapter,
        "packageDeployReady",
        result,
        artifactHash === undefined ? [] : [artifactHash],
      )
      const security =
        packaged.status === "passed"
          ? await createSecurityReceipt(manifest, adapter, packaged, options.store.projectRoot)
          : createReceipt(manifest, adapter, "security", result)
      const receipts = [...verification.receipts, packaged, security]
      if (packaged.status === "passed" && security.status === "passed") {
        await buildAndPersistRunnerEvidence(
          options.store,
          manifest,
          adapter,
          { ...verification.results, packageDeployReady: result },
          receipts,
          context,
        )
      }
      const checks = [
        ...verification.receipts.map((receipt) => readinessCheck(checkId(receipt), receipt)),
        readinessCheck("release-bundle", packaged),
        readinessCheck("security", security),
      ]
      await persistTrustedEvidence(options.store, receipts, checks)
      currentChecks = checks
      return packaged.status === "passed" && security.status === "passed"
        ? completed(receipts)
        : { kind: "unverified", missingCapabilities: ["adapter-deploy-ready"] }
    } catch (error) {
      currentChecks = []
      return {
        kind: "unverified",
        missingCapabilities: [error instanceof Error ? error.message : "trusted-adapter-receipt"],
      }
    }
  }
  return { execute, readinessChecks: () => currentChecks }
}

export function createTrustedAdapterExecutor(options: TrustedAdapterExecutorOptions) {
  return createTrustedAdapterSession(options).execute
}
