import type { PipelineStage, RunManifest } from "../domain/manifest.js"
import { Pipeline, type StageResult } from "../engine/pipeline.js"
import { sealRunCheckpoints } from "../execution/codex-stage-checkpoint"
import { createCodexStageExecutor } from "../execution/codex-stage-executor"
import { createTrustedAdapterSession } from "../execution/trusted-adapter-executor"
import { DecisionLedger } from "../state/decision-ledger"
import type { ProjectStore } from "../state/project-store.js"
import type { CliServices } from "./contracts"

async function gateResult(
  ledger: DecisionLedger,
  stage: "scope-approval" | "design-selection",
  manifest: Readonly<RunManifest>,
  now: string,
): Promise<StageResult> {
  const scopeGate = stage === "scope-approval"
  const delegatedDesign = !scopeGate && manifest.designPolicy.mode === "delegated"
  const autoResolve = manifest.workflowProfile === "lean" || delegatedDesign
  const id = scopeGate ? "gate-1-prd-scope" : "gate-2-design-direction"
  const selected = scopeGate
    ? "focused-v1"
    : delegatedDesign
      ? "api-contract-first"
      : "clarity-first"
  const source = manifest.stages[scopeGate ? "research-prd" : "design-candidates"]
  const gateEvidence = source.kind === "completed" ? source.evidenceIds : []
  const existing = (await ledger.listRun(manifest.runId)).find((decision) => decision.id === id)
  let decision =
    existing ??
    (await ledger.initialize({
      id,
      runId: manifest.runId,
      stage,
      category: scopeGate ? "product-scope" : "design-direction",
      blocking: !autoResolve,
      recommendation: scopeGate
        ? "Approve a focused v1 scope with complete verification."
        : delegatedDesign
          ? "Use an API-contract-first product direction with explicit operational feedback."
          : "Choose the clarity-first design direction.",
      alternatives: scopeGate
        ? [
            {
              id: "focused-v1",
              label: "Focused complete v1",
              score: 92,
              tradeoffs: "Fewer features, stronger quality and faster validation.",
            },
            {
              id: "broad-v1",
              label: "Broader first release",
              score: 73,
              tradeoffs: "More features, more schedule and verification risk.",
            },
          ]
        : delegatedDesign
          ? [
              {
                id: "api-contract-first",
                label: "API contract first",
                score: 92,
                tradeoffs: "Optimizes integration clarity while keeping operations visible.",
              },
              {
                id: "operations-first",
                label: "Operations first",
                score: 84,
                tradeoffs: "Optimizes incident response with a denser integration contract.",
              },
            ]
          : [
              {
                id: "clarity-first",
                label: "Clarity-first",
                score: 91,
                tradeoffs: "Fast comprehension and restrained visual density.",
              },
              {
                id: "workflow-first",
                label: "Workflow-first",
                score: 84,
                tradeoffs: "Faster repeat use with a steeper first-use curve.",
              },
              {
                id: "exploration-first",
                label: "Exploration-first",
                score: 78,
                tradeoffs: "More discovery at the cost of stronger navigation demands.",
              },
            ],
      businessImpact: scopeGate
        ? "Defines launch time, cost, and the depth of required validation."
        : delegatedDesign
          ? "Sets integration comprehension and operational recovery expectations without a visual-design gate."
          : "Sets comprehension, task speed, and accessibility expectations before implementation.",
      evidence: gateEvidence,
      actor: "harness",
      createdAt: now,
    }))
  if (autoResolve && decision.status === "pending") {
    decision = await ledger.mutate({
      id: decision.id,
      runId: manifest.runId,
      expectedRevision: decision.revision,
      action: "approve",
      selected,
      reason:
        manifest.workflowProfile === "lean"
          ? "Routine workflow recommendation accepted by the lean execution profile."
          : manifest.designPolicy.reason,
      actor: "harness",
      idempotencyKey: `auto-${stage}-${decision.eventHash.slice(0, 16)}`,
      decidedAt: now,
    })
  }
  return decision.status === "approved"
    ? {
        kind: "completed",
        outputHash: decision.eventHash,
        evidenceIds: [`decision:${manifest.runId}:${decision.id}:${decision.revision}`],
        appliedDecision: { id: decision.id, revision: decision.revision },
      }
    : { kind: "blocked", decisionIds: [id] }
}

async function defaultStageExecutor(
  stage: PipelineStage,
  manifest: Readonly<RunManifest>,
  store: ProjectStore,
  now: string,
  executeCodex: (stage: PipelineStage, manifest: Readonly<RunManifest>) => Promise<StageResult>,
  executeTrusted: (stage: PipelineStage, manifest: Readonly<RunManifest>) => Promise<StageResult>,
): Promise<StageResult> {
  if (stage === "scope-approval" || stage === "design-selection") {
    return gateResult(new DecisionLedger(store.projectRoot), stage, manifest, now)
  }
  const modelResult = await executeCodex(stage, manifest)
  if (modelResult.kind !== "completed") return modelResult
  if (stage === "verification" || stage === "deploy-ready") {
    const trustedResult = await executeTrusted(stage, manifest)
    if (trustedResult.kind !== "completed") return trustedResult
    return {
      kind: "completed",
      outputHash: `${modelResult.outputHash}:${trustedResult.outputHash}`,
      evidenceIds: [...modelResult.evidenceIds, ...trustedResult.evidenceIds],
    }
  }
  return modelResult
}

export async function runPipeline(
  store: ProjectStore,
  manifest: RunManifest,
  services: CliServices,
) {
  const now = services.now?.() ?? new Date().toISOString()
  const executeCodex = createCodexStageExecutor({
    store,
    binary: services.codexBinary,
    transport: services.codexTransport,
    appServerSocket: services.codexAppServerSocket,
    timeoutMs: services.codexTimeoutMs,
    signal: services.signal,
    now: services.now,
  })
  const trustedSession = createTrustedAdapterSession({
    store,
    ...(services.adapters === undefined ? {} : { adapters: services.adapters }),
    ...(services.adapterToolchainPath === undefined
      ? {}
      : { toolchainPath: services.adapterToolchainPath }),
    ...(services.adapterExecutionEnvironment === undefined
      ? {}
      : { executionEnvironment: services.adapterExecutionEnvironment }),
  })
  const pipeline = new Pipeline({
    execute:
      services.executeStage ??
      ((stage, nextManifest) =>
        defaultStageExecutor(
          stage,
          nextManifest,
          store,
          now,
          executeCodex,
          trustedSession.execute,
        )),
    save: (next) => store.saveManifest(next),
    readinessChecks: async () => {
      if (trustedSession.readinessChecks().length === 0) {
        await trustedSession.execute("deploy-ready", manifest)
      }
      return trustedSession.readinessChecks()
    },
    ...(services.now === undefined ? {} : { now: services.now }),
  })
  const result = await pipeline.run(manifest)
  if (result.kind === "completed" && result.manifest.releaseReady) {
    try {
      await sealRunCheckpoints(store, result.manifest)
    } catch (error) {
      result.manifest.releaseReady = false
      await store.saveManifest(result.manifest)
      throw error
    }
  }
  return result
}
