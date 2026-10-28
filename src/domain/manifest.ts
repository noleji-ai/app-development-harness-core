import { z } from "zod"
import { DEFAULT_DESIGN_POLICY, type DesignPolicy, DesignPolicySchema } from "./design-policy"

export const PIPELINE_STAGES = [
  "request-analysis",
  "research-prd",
  "scope-approval",
  "design-candidates",
  "design-selection",
  "technology-optimization",
  "implementation",
  "verification",
  "deploy-ready",
] as const

export type PipelineStage = (typeof PIPELINE_STAGES)[number]
export type RunMode = "create" | "extend" | "resume"
export const WORKFLOW_PROFILES = ["lean", "full"] as const
export type WorkflowProfile = (typeof WORKFLOW_PROFILES)[number]
export const LEAN_VERIFICATION_SKIP_REASON =
  "lean-profile-trusted-verification-runs-at-deploy-ready"

export class ManifestInputError extends Error {
  override readonly name = "ManifestInputError"
}

export type StageState =
  | { kind: "pending" }
  | { kind: "skipped"; reason: string }
  | { kind: "running"; inputHash: string; attemptId: string; startedAt: string }
  | { kind: "blocked"; inputHash: string; decisionIds: string[] }
  | {
      kind: "completed"
      inputHash: string
      outputHash: string
      evidenceIds: string[]
      completedAt: string
    }
  | { kind: "failed"; inputHash: string; attemptId: string; error: string }
  | { kind: "unverified"; inputHash: string; missingCapabilities: string[] }

export interface RunManifest {
  schemaVersion: 1
  generation: number
  runId: string
  mode: RunMode
  workflowProfile: WorkflowProfile
  request: string
  designPolicy: DesignPolicy
  createdAt: string
  updatedAt: string
  currentStage: PipelineStage
  stages: Record<PipelineStage, StageState>
  decisionRevisions: Record<string, number>
  adapterId: string | null
  releaseReady: boolean
}

export const PipelineStageSchema = z.enum(PIPELINE_STAGES)
export const RunModeSchema = z.enum(["create", "extend", "resume"])
export const WorkflowProfileSchema = z.enum(WORKFLOW_PROFILES)

export const StageStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }).strict(),
  z.object({ kind: z.literal("skipped"), reason: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("running"),
      inputHash: z.string(),
      attemptId: z.string(),
      startedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("blocked"),
      inputHash: z.string(),
      decisionIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("completed"),
      inputHash: z.string(),
      outputHash: z.string(),
      evidenceIds: z.array(z.string().trim().min(1)).min(1),
      completedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      inputHash: z.string(),
      attemptId: z.string(),
      error: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unverified"),
      inputHash: z.string(),
      missingCapabilities: z.array(z.string()),
    })
    .strict(),
])

export const RunManifestSchema: z.ZodType<RunManifest> = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative(),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    mode: RunModeSchema,
    workflowProfile: WorkflowProfileSchema.default("full"),
    request: z.string(),
    designPolicy: DesignPolicySchema.default(DEFAULT_DESIGN_POLICY),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    currentStage: PipelineStageSchema,
    stages: z.record(PipelineStageSchema, StageStateSchema),
    decisionRevisions: z
      .record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), z.number().int().positive())
      .default({}),
    adapterId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .nullable()
      .default(null),
    releaseReady: z.boolean(),
  })
  .strict()

function pendingStages(): Record<PipelineStage, StageState> {
  return {
    "request-analysis": { kind: "pending" },
    "research-prd": { kind: "pending" },
    "scope-approval": { kind: "pending" },
    "design-candidates": { kind: "pending" },
    "design-selection": { kind: "pending" },
    "technology-optimization": { kind: "pending" },
    implementation: { kind: "pending" },
    verification: { kind: "pending" },
    "deploy-ready": { kind: "pending" },
  }
}

export function createManifest(
  runId: string,
  mode: RunMode,
  request: string,
  now = new Date().toISOString(),
  designPolicy: DesignPolicy = DEFAULT_DESIGN_POLICY,
  workflowProfile: WorkflowProfile = "lean",
): RunManifest {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new ManifestInputError("Invalid run id")
  }
  return {
    schemaVersion: 1,
    generation: 0,
    runId,
    mode,
    workflowProfile,
    request,
    designPolicy,
    createdAt: now,
    updatedAt: now,
    currentStage: PIPELINE_STAGES[0],
    stages: pendingStages(),
    decisionRevisions: {},
    adapterId: null,
    releaseReady: false,
  }
}

export function isGate(stage: PipelineStage): boolean {
  return stage === "scope-approval" || stage === "design-selection"
}
