import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import type { PipelineStage } from "../domain/manifest"

const CorrelationSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  stage: z.string().min(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
})
const TextSchema = z.string().trim().min(3).max(4000)
const TextListSchema = z.array(TextSchema).min(1).max(50)

const RequestAnalysisSchema = CorrelationSchema.extend({
  users: TextListSchema,
  problem: TextSchema,
  outcomes: TextListSchema,
  platforms: TextListSchema,
  constraints: TextListSchema,
  nonFunctionalRequirements: TextListSchema,
}).strict()

const PrdSchema = CorrelationSchema.extend({
  product: TextSchema,
  problem: TextSchema,
  successMetrics: TextListSchema,
  inScope: TextListSchema,
  outOfScope: TextListSchema,
  constraints: TextListSchema,
  nonFunctionalRequirements: TextListSchema,
}).strict()

const DesignCandidatesSchema = CorrelationSchema.extend({
  directions: z
    .array(
      z
        .object({
          id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
          name: TextSchema,
          informationArchitecture: TextSchema,
          interactionModel: TextSchema,
          visualLanguage: TextSchema,
        })
        .strict(),
    )
    .min(2)
    .max(5),
}).strict()

const TechnologyDecisionSchema = CorrelationSchema.extend({
  selectedAdapterId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  confidence: z.number().min(0).max(1),
  rationale: TextSchema,
  alternatives: z
    .array(
      z
        .object({
          adapterId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
          score: z.number().min(0).max(100),
          reason: TextSchema,
        })
        .strict(),
    )
    .min(1)
    .max(12),
}).strict()

const REQUIRED_ARTIFACTS = {
  "request-analysis": { id: "request-analysis", schema: RequestAnalysisSchema },
  "research-prd": { id: "prd", schema: PrdSchema },
  "design-candidates": { id: "design-candidates", schema: DesignCandidatesSchema },
  "technology-optimization": { id: "technology-optimization", schema: TechnologyDecisionSchema },
} as const

export interface CorrelatedArtifact {
  readonly id: string
  readonly path: string
}

export async function validateSubstantiveArtifact(
  projectRoot: string,
  stage: PipelineStage,
  expected: { readonly runId: string; readonly inputHash: string },
  artifacts: readonly CorrelatedArtifact[],
): Promise<{ readonly adapterId?: string }> {
  if (!(stage in REQUIRED_ARTIFACTS)) return {}
  const requirement = REQUIRED_ARTIFACTS[stage as keyof typeof REQUIRED_ARTIFACTS]
  const artifact = artifacts.find((candidate) => candidate.id === requirement.id)
  if (artifact === undefined) throw new Error(`${stage} requires typed artifact ${requirement.id}`)
  const raw = JSON.parse(await readFile(join(projectRoot, artifact.path), "utf8"))
  const value = requirement.schema.parse(raw)
  if (
    value.runId !== expected.runId ||
    value.stage !== stage ||
    value.inputHash !== expected.inputHash
  ) {
    throw new Error(`${stage} artifact correlation is stale or mismatched`)
  }
  if (stage === "design-candidates") {
    const directions = DesignCandidatesSchema.parse(value).directions
    if (new Set(directions.map((item) => item.id)).size !== directions.length) {
      throw new Error("design candidates contain duplicate identifiers")
    }
  }
  if (stage === "technology-optimization") {
    return { adapterId: TechnologyDecisionSchema.parse(value).selectedAdapterId }
  }
  return {}
}

export function artifactInstruction(stage: PipelineStage): string {
  const requirement = Object.entries(REQUIRED_ARTIFACTS).find(([key]) => key === stage)?.[1]
  if (requirement === undefined) return "Create substantive local evidence for the completed work."
  return `Create evidence id ${requirement.id} as a correlated JSON file conforming exactly to this artifact schema.
The evidence id belongs in the final output's evidence list, not as an extra field in the artifact file.
Use the exact runId, stage and inputHash from context. Select only a supported adapter when applicable.
<artifact-json-schema>${JSON.stringify(z.toJSONSchema(requirement.schema))}</artifact-json-schema>`
}
