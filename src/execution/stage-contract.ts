import { z } from "zod"

import { type PipelineStage, PipelineStageSchema } from "../domain/manifest"

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const EvidencePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (path) => path !== ".app-harness" && !path.startsWith(".app-harness/"),
    "model evidence path is invalid",
  )

const EvidenceSchema = z
  .object({
    id: IdentifierSchema,
    path: EvidencePathSchema,
    description: z.string().trim().min(1).max(2000),
  })
  .strict()

export const CodexStageOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: IdentifierSchema,
    stage: PipelineStageSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["completed", "blocked", "failed", "unverified"]),
    summary: z.string().trim().max(4000),
    evidence: z.array(EvidenceSchema).max(100),
    decisionIds: z.array(IdentifierSchema).max(3),
    missingCapabilities: z.array(IdentifierSchema).max(50),
    error: z.string().trim().max(4000),
  })
  .strict()

export type CodexStageOutput = z.infer<typeof CodexStageOutputSchema>

export const CODEX_STAGE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "runId",
    "stage",
    "inputHash",
    "status",
    "summary",
    "evidence",
    "decisionIds",
    "missingCapabilities",
    "error",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    runId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    stage: { type: "string", enum: [...PipelineStageSchema.options] },
    inputHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    status: { type: "string", enum: ["completed", "blocked", "failed", "unverified"] },
    summary: { type: "string", maxLength: 4000 },
    evidence: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path", "description"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          path: { type: "string", minLength: 1, maxLength: 1024 },
          description: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
    decisionIds: {
      type: "array",
      maxItems: 3,
      items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    },
    missingCapabilities: {
      type: "array",
      maxItems: 50,
      items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    },
    error: { type: "string", maxLength: 4000 },
  },
} as const

export class CodexStageOutputError extends Error {
  override readonly name = "CodexStageOutputError"
}

export function parseCodexStageOutput(
  raw: unknown,
  expected: { runId: string; stage: PipelineStage; inputHash: string },
): CodexStageOutput {
  const output = CodexStageOutputSchema.parse(raw)
  if (
    output.runId !== expected.runId ||
    output.stage !== expected.stage ||
    output.inputHash !== expected.inputHash
  ) {
    throw new CodexStageOutputError("Codex result correlation is stale or mismatched")
  }
  const evidenceIds = new Set(output.evidence.map((item) => item.id))
  if (evidenceIds.size !== output.evidence.length) {
    throw new CodexStageOutputError("Codex result contains duplicate evidence identifiers")
  }
  if (output.status === "completed" && output.evidence.length === 0) {
    throw new CodexStageOutputError("Completed Codex result requires evidence")
  }
  if (
    output.status === "completed" &&
    (output.decisionIds.length > 0 || output.missingCapabilities.length > 0 || output.error !== "")
  ) {
    throw new CodexStageOutputError("Completed Codex result contains a contradictory outcome")
  }
  if (output.status === "blocked" && output.decisionIds.length === 0) {
    throw new CodexStageOutputError("Blocked Codex result requires a decision")
  }
  if (output.status === "failed" && output.error.length === 0) {
    throw new CodexStageOutputError("Failed Codex result requires an error")
  }
  if (output.status === "unverified" && output.missingCapabilities.length === 0) {
    throw new CodexStageOutputError("Unverified Codex result requires a missing capability")
  }
  if (
    output.status !== "completed" &&
    ((output.status !== "blocked" && output.decisionIds.length > 0) ||
      (output.status !== "failed" && output.error !== "") ||
      (output.status !== "unverified" && output.missingCapabilities.length > 0))
  ) {
    throw new CodexStageOutputError("Codex result contains contradictory status fields")
  }
  return output
}
