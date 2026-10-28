import { createHash, randomUUID } from "node:crypto"

import {
  LEAN_VERIFICATION_SKIP_REASON,
  PIPELINE_STAGES,
  type PipelineStage,
  type RunManifest,
} from "../domain/manifest.js"
import {
  assessReadiness,
  REQUIRED_RELEASE_CHECK_IDS,
  type VerificationCheck,
} from "../release/readiness.js"

export type StageResult =
  | {
      kind: "completed"
      outputHash: string
      evidenceIds: string[]
      adapterId?: string | undefined
      appliedDecision?: { readonly id: string; readonly revision: number }
    }
  | { kind: "blocked"; decisionIds: string[] }
  | { kind: "failed"; error: string }
  | { kind: "unverified"; missingCapabilities: string[] }

export type PipelineResult =
  | { kind: "completed"; manifest: RunManifest }
  | { kind: "blocked" | "failed" | "unverified"; stage: PipelineStage; manifest: RunManifest }

export interface PipelineDependencies {
  execute(stage: PipelineStage, manifest: Readonly<RunManifest>): Promise<StageResult>
  save(manifest: RunManifest): Promise<void>
  readinessChecks?(): Promise<readonly VerificationCheck[]>
  readonly requiredCheckIds?: readonly string[]
  inputHash?(manifest: Readonly<RunManifest>, stage: PipelineStage): string
  now?(): string
  attemptId?(): string
}

export class PipelinePolicyError extends Error {
  override readonly name = "PipelinePolicyError"
}

function hasEvidence(evidenceIds: readonly string[]): boolean {
  return evidenceIds.length > 0 && evidenceIds.every((id) => id.trim().length > 0)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function defaultInputHash(manifest: Readonly<RunManifest>, stage: PipelineStage): string {
  const index = PIPELINE_STAGES.indexOf(stage)
  const predecessors = PIPELINE_STAGES.slice(0, index).map((name) => {
    const state = manifest.stages[name]
    return state.kind === "completed" ? state.outputHash : state.kind
  })
  return createHash("sha256")
    .update(
      canonical({
        runId: manifest.runId,
        mode: manifest.mode,
        workflowProfile: manifest.workflowProfile,
        request: manifest.request,
        designPolicy: manifest.designPolicy,
        stage,
        predecessors,
      }),
    )
    .digest("hex")
}

export class Pipeline {
  constructor(private readonly dependencies: PipelineDependencies) {}

  async run(manifest: RunManifest): Promise<PipelineResult> {
    for (const [index, stage] of PIPELINE_STAGES.entries()) {
      manifest.currentStage = stage
      const skipReason =
        manifest.workflowProfile === "lean" && stage === "verification"
          ? LEAN_VERIFICATION_SKIP_REASON
          : manifest.designPolicy.mode === "skip" &&
              (stage === "design-candidates" || stage === "design-selection")
            ? manifest.designPolicy.reason
            : manifest.designPolicy.mode === "delegated" && stage === "design-candidates"
              ? manifest.designPolicy.reason
              : undefined
      if (skipReason !== undefined) {
        const previous = manifest.stages[stage]
        if (previous.kind !== "skipped" || previous.reason !== skipReason) {
          manifest.stages[stage] = { kind: "skipped", reason: skipReason }
          manifest.updatedAt = (this.dependencies.now ?? (() => new Date().toISOString()))()
          await this.dependencies.save(manifest)
        }
        continue
      }
      const inputHash = (this.dependencies.inputHash ?? defaultInputHash)(manifest, stage)
      const previous = manifest.stages[stage]
      const obsoletePlaceholder =
        previous.kind === "completed" &&
        previous.outputHash === stage &&
        previous.evidenceIds.includes(`state:${stage}`)
      const missingAdapterSelection =
        stage === "technology-optimization" && manifest.adapterId === null
      if (
        previous.kind === "completed" &&
        previous.inputHash === inputHash &&
        !obsoletePlaceholder &&
        !missingAdapterSelection
      ) {
        continue
      }
      if (
        previous.kind === "completed" &&
        (previous.inputHash !== inputHash || obsoletePlaceholder || missingAdapterSelection)
      ) {
        for (const downstream of PIPELINE_STAGES.slice(index)) {
          manifest.stages[downstream] = { kind: "pending" }
        }
      }

      const now = (this.dependencies.now ?? (() => new Date().toISOString()))()
      const attemptId = (this.dependencies.attemptId ?? randomUUID)()
      manifest.stages[stage] = { kind: "running", inputHash, attemptId, startedAt: now }
      manifest.updatedAt = now
      await this.dependencies.save(manifest)

      const result = await this.dependencies.execute(stage, manifest)
      if (result.kind === "blocked") {
        if (result.decisionIds.length > 3) {
          throw new PipelinePolicyError(
            `Stage ${stage} exposed ${result.decisionIds.length} blockers; maximum of 3`,
          )
        }
        manifest.stages[stage] = {
          kind: "blocked",
          inputHash,
          decisionIds: [...result.decisionIds],
        }
      } else if (result.kind === "failed") {
        manifest.stages[stage] = { kind: "failed", inputHash, attemptId, error: result.error }
      } else if (result.kind === "unverified") {
        manifest.stages[stage] = {
          kind: "unverified",
          inputHash,
          missingCapabilities: [...result.missingCapabilities],
        }
      } else {
        if (!hasEvidence(result.evidenceIds)) {
          manifest.stages[stage] = {
            kind: "unverified",
            inputHash,
            missingCapabilities: ["stage-evidence"],
          }
          manifest.releaseReady = false
          manifest.updatedAt = now
          await this.dependencies.save(manifest)
          return { kind: "unverified", stage, manifest }
        }
        manifest.stages[stage] = {
          kind: "completed",
          inputHash,
          outputHash: result.outputHash,
          evidenceIds: [...result.evidenceIds],
          completedAt: now,
        }
        if (result.adapterId !== undefined) manifest.adapterId = result.adapterId
        if (result.appliedDecision !== undefined) {
          manifest.decisionRevisions[result.appliedDecision.id] = result.appliedDecision.revision
        }
      }
      manifest.updatedAt = now
      if (result.kind !== "completed") manifest.releaseReady = false
      await this.dependencies.save(manifest)
      if (result.kind !== "completed") return { kind: result.kind, stage, manifest }
    }
    try {
      const checks = (await this.dependencies.readinessChecks?.()) ?? []
      manifest.releaseReady = assessReadiness(
        checks,
        this.dependencies.requiredCheckIds ?? REQUIRED_RELEASE_CHECK_IDS,
      ).ready
    } catch (error) {
      manifest.releaseReady = false
      await this.dependencies.save(manifest)
      throw error
    }
    await this.dependencies.save(manifest)
    return { kind: "completed", manifest }
  }
}
