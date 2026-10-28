import { z } from "zod"
import { PipelineStageSchema } from "./manifest"

export const DecisionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "revision_requested",
])

export const DecisionAlternativeSchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(200),
    score: z.number().min(0).max(100),
    tradeoffs: z.string().max(2000),
  })
  .strict()

export const DecisionInputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    stage: PipelineStageSchema,
    category: z.string().min(1).max(128),
    blocking: z.boolean(),
    recommendation: z.string().min(1).max(4000),
    alternatives: z.array(DecisionAlternativeSchema).min(1).max(20),
    businessImpact: z.string().max(4000),
    evidence: z.array(z.string().min(1).max(512)).max(50),
    actor: z.string().min(1).max(128),
    createdAt: z.iso.datetime(),
  })
  .strict()

export const DecisionActionSchema = z.enum(["approve", "reject", "request_revision", "comment"])

export const DecisionMutationSchema = z
  .object({
    id: z.string().min(1).max(128),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    expectedRevision: z.number().int().nonnegative(),
    action: DecisionActionSchema,
    selected: z.string().min(1).max(128).optional(),
    reason: z.string().min(1).max(4000),
    actor: z.string().min(1).max(128),
    idempotencyKey: z.string().min(8).max(128),
    decidedAt: z.iso.datetime(),
  })
  .strict()

type ParsedDecisionInput = z.infer<typeof DecisionInputSchema>
export type DecisionInput = Omit<ParsedDecisionInput, "alternatives" | "evidence"> & {
  readonly alternatives: readonly z.infer<typeof DecisionAlternativeSchema>[]
  readonly evidence: readonly string[]
}
export type DecisionMutation = z.infer<typeof DecisionMutationSchema>
export type DecisionAction = z.infer<typeof DecisionActionSchema>
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>

export type DecisionRecord = DecisionInput & {
  readonly status: DecisionStatus
  readonly selected: string | null
  readonly reason: string | null
  readonly decidedAt: string | null
  readonly revision: number
  readonly previousHash: string | null
  readonly eventHash: string
  readonly idempotencyKey: string
  readonly action?: DecisionAction | undefined
  readonly mutationHash?: string | undefined
}

export const DecisionRecordSchema = DecisionInputSchema.extend({
  status: DecisionStatusSchema,
  selected: z.string().min(1).max(128).nullable(),
  reason: z.string().max(4000).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  previousHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(128),
  action: DecisionActionSchema.optional(),
  mutationHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
}).strict()
