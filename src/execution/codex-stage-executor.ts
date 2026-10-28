import { join } from "node:path"

import type { PipelineStage, RunManifest } from "../domain/manifest"
import type { StageResult } from "../engine/pipeline"
import { appendStateFile, atomicWriteStateFile } from "../state/atomic-state-file"
import { DecisionLedger } from "../state/decision-ledger"
import type { ProjectStore } from "../state/project-store"
import { runCodexAppServer } from "./codex-app-server"
import { type CodexTransportResult, runCodexExec } from "./codex-exec"
import {
  bindCheckpointUsage,
  digest,
  toStageResult,
  validCheckpoint,
  verifyArtifacts,
  writeCheckpoint,
} from "./codex-stage-checkpoint"
import {
  codexBinary,
  codexTimeout,
  codexTransport,
  createStagePrompt,
  diagnostic,
  environmentValue,
  isCodexStage,
} from "./codex-stage-prompt"
import { captureDirtyWorktree } from "./dirty-worktree"
import { ImplementationTierSchema, ModelPolicySchema, resolveModelPolicy } from "./model-policy"
import type { ModelUsage } from "./model-usage"
import { validateSubstantiveArtifact } from "./stage-artifacts"
import { CODEX_STAGE_OUTPUT_JSON_SCHEMA, parseCodexStageOutput } from "./stage-contract"
import { assertTrustedUnchanged, validateBlockedResult } from "./stage-decision-validation"
import { captureTrustedEvidence } from "./trusted-evidence-guard"
import { writeUsageReceipt } from "./usage-receipt"
import { workspaceDigest } from "./workspace-digest"

export interface CodexStageExecutorOptions {
  readonly store: ProjectStore
  readonly binary?: string | undefined
  readonly transport?: "exec" | "app-server" | undefined
  readonly appServerSocket?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly now?: (() => string) | undefined
}

async function transport(
  options: CodexStageExecutorOptions,
  stage: Parameters<typeof createStagePrompt>[0],
  manifest: Readonly<RunManifest>,
  inputHash: string,
  protectedPaths: readonly string[],
  schemaPath: string,
  outputPath: string,
): Promise<CodexTransportResult> {
  try {
    const selected = codexTransport(options.transport)
    const common = {
      policy: resolveModelPolicy(
        stage,
        ImplementationTierSchema.parse(
          environmentValue("APP_HARNESS_IMPLEMENTATION_TIER") ?? "standard",
        ),
      ),
      projectRoot: options.store.projectRoot,
      binary: codexBinary(options.binary),
      prompt: await createStagePrompt(
        stage,
        manifest,
        inputHash,
        new DecisionLedger(options.store.projectRoot),
        protectedPaths,
      ),
      schemaPath,
      outputPath,
      timeoutMs: codexTimeout(options.timeoutMs),
      signal: options.signal,
    }
    if (selected === "app-server") {
      const started = Date.now()
      const result = await runCodexAppServer({
        ...common,
        socket: options.appServerSocket ?? environmentValue("APP_HARNESS_CODEX_APP_SERVER_SOCKET"),
      })
      const remaining = common.timeoutMs - (Date.now() - started)
      if (!result.safeToRetry || remaining <= 0) return result
      return await runCodexExec({ ...common, timeoutMs: remaining })
    }
    return await runCodexExec(common)
  } catch (error) {
    return { kind: "failed", error: diagnostic(error) }
  }
}

export function createCodexStageExecutor(
  options: CodexStageExecutorOptions,
): (stage: PipelineStage, manifest: Readonly<RunManifest>) => Promise<StageResult> {
  return async (stage, manifest) => {
    if (!isCodexStage(stage)) throw new Error(`Codex executor does not own stage: ${stage}`)
    const state = manifest.stages[stage]
    if (state.kind !== "running") throw new Error(`Codex stage is not running: ${stage}`)
    const policy = resolveModelPolicy(
      stage,
      ImplementationTierSchema.parse(
        environmentValue("APP_HARNESS_IMPLEMENTATION_TIER") ?? "standard",
      ),
    )
    const key = digest(`${manifest.runId}:${stage}:${state.inputHash}:${JSON.stringify(policy)}`)
    const checkpointPath = join(options.store.stateRoot, "evidence", `codex-${key}.checkpoint.json`)
    const checkpoint = await validCheckpoint(options.store, checkpointPath, {
      runId: manifest.runId,
      stage,
      inputHash: state.inputHash,
    })
    if (checkpoint !== undefined && checkpoint.result.kind === "completed") return checkpoint.result

    const usagePath = join(options.store.stateRoot, "evidence", "model-usage.jsonl")
    let started = Date.now()
    const execution = {
      runId: manifest.runId,
      stage,
      attemptId: state.attemptId,
      inputHash: state.inputHash,
      policy,
    }
    let invoked = false
    let observedUsage: ModelUsage | null = null
    let transportOutcome = "not_started"
    const attempt = async (): Promise<StageResult> => {
      let dirty: Awaited<ReturnType<typeof captureDirtyWorktree>>
      let restoreTrusted: () => Promise<boolean>
      try {
        dirty = await captureDirtyWorktree(options.store.projectRoot)
      } catch (error) {
        return { kind: "unverified", missingCapabilities: [`dirty-worktree: ${diagnostic(error)}`] }
      }
      const schemaPath = join(options.store.stateRoot, "evidence", `codex-${key}.schema.json`)
      const outputPath = join(options.store.stateRoot, "evidence", `codex-${key}.output.json`)
      await atomicWriteStateFile(
        options.store.projectRoot,
        schemaPath,
        `${JSON.stringify(CODEX_STAGE_OUTPUT_JSON_SCHEMA)}\n`,
      )
      await atomicWriteStateFile(options.store.projectRoot, outputPath, "")
      started = Date.now()
      await appendStateFile(
        options.store.projectRoot,
        usagePath,
        `${JSON.stringify({ ...execution, event: "started", startedAt: new Date(started).toISOString(), usage: null })}\n`,
      )
      invoked = true
      restoreTrusted = await captureTrustedEvidence(options.store)
      const transportResult = await transport(
        options,
        stage,
        manifest,
        state.inputHash,
        dirty.paths,
        schemaPath,
        outputPath,
      )
      observedUsage = transportResult.kind === "output" ? (transportResult.usage ?? null) : null
      transportOutcome = transportResult.kind
      try {
        const restored = await dirty.restoreChanges()
        if (await restoreTrusted()) {
          return { kind: "failed", error: "Codex attempted to modify trusted release evidence" }
        }
        if (restored.length > 0) {
          return {
            kind: "failed",
            error: `Codex attempted to change protected work: ${restored.join(", ")}`,
          }
        }
      } catch (error) {
        return { kind: "unverified", missingCapabilities: [`state-restore: ${diagnostic(error)}`] }
      }
      const usage = transportResult.kind === "output" ? (transportResult.usage ?? null) : null
      if (usage?.reportedModel && usage.reportedModel !== policy.model) {
        return {
          kind: "failed",
          error: "Codex reported a different model than the execution policy",
        }
      }
      if (transportResult.kind === "failed") return { kind: "failed", error: transportResult.error }
      if (transportResult.kind === "unverified") {
        return { kind: "unverified", missingCapabilities: [transportResult.missingCapability] }
      }

      try {
        const output = parseCodexStageOutput(JSON.parse(transportResult.output), {
          runId: manifest.runId,
          stage,
          inputHash: state.inputHash,
        })
        const artifacts = await verifyArtifacts(options.store.projectRoot, output)
        const artifactState = await validateSubstantiveArtifact(
          options.store.projectRoot,
          stage,
          { runId: manifest.runId, inputHash: state.inputHash },
          artifacts,
        )
        const result = toStageResult(
          output,
          artifacts,
          `codex-execution:${manifest.runId}:${stage}:${key.slice(0, 16)}`,
          artifactState.adapterId,
          diagnostic,
        )
        await validateBlockedResult(options.store, manifest, result)
        if (result.kind === "completed") {
          await assertTrustedUnchanged(restoreTrusted)
          await writeCheckpoint(options.store, checkpointPath, {
            schemaVersion: 3,
            policyHash: digest(JSON.stringify(ModelPolicySchema.parse(policy))),
            sourceHash: await workspaceDigest(options.store.projectRoot),
            runId: manifest.runId,
            stage,
            inputHash: state.inputHash,
            transport: transportResult.transport,
            transcriptHash: transportResult.transcriptHash,
            artifacts,
            result,
            completedAt: options.now?.() ?? new Date().toISOString(),
          })
        }
        return result
      } catch (error) {
        return { kind: "failed", error: diagnostic(error) }
      }
    }
    let result: StageResult
    try {
      result = await attempt()
    } catch (error) {
      result = { kind: "failed", error: diagnostic(error) }
    }
    if (invoked) {
      const record = {
        ...execution,
        event: "finished",
        outcome: result.kind,
        transportOutcome,
        modelCalls: transportOutcome === "not_started" ? 0 : 1,
        startedAt: new Date(started).toISOString(),
        wallMs: Date.now() - started,
        usage: observedUsage,
      }
      const usage = await writeUsageReceipt(options.store, record)
      if (result.kind === "completed")
        await bindCheckpointUsage(options.store, checkpointPath, usage)
    }
    return result
  }
}
