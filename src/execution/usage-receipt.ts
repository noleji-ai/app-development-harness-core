import { createHash } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { PipelineStageSchema } from "../domain/manifest"
import { appendStateFile, createStateFile } from "../state/atomic-state-file"
import type { ProjectStore } from "../state/project-store"
import { ModelPolicySchema } from "./model-policy"

const Counter = z.number().int().nonnegative().safe()
const Receipt = z
  .object({
    runId: z.string(),
    stage: PipelineStageSchema,
    attemptId: z.string(),
    inputHash: z.string(),
    policy: ModelPolicySchema,
    event: z.literal("finished"),
    outcome: z.enum(["completed", "failed", "blocked", "unverified"]),
    transportOutcome: z.enum(["output", "failed", "unverified", "not_started"]),
    modelCalls: z.union([z.literal(0), z.literal(1)]),
    startedAt: z.iso.datetime(),
    wallMs: Counter,
    usage: z
      .object({
        tokens: z
          .object({ input: Counter, cachedInput: Counter, output: Counter })
          .strict()
          .nullable(),
        reportedModel: z.string().nullable(),
        toolCalls: Counter,
      })
      .strict()
      .nullable(),
  })
  .strict()

export async function writeUsageReceipt(
  store: ProjectStore,
  raw: unknown,
): Promise<{ usageRef: string; usageHash: string }> {
  const record = Receipt.parse(raw)
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const usageRef = `model-execution-${hash(`${record.runId}:${record.attemptId}`)}.json`
  const contents = `${JSON.stringify(record)}\n`
  await createStateFile(store.projectRoot, join(store.stateRoot, "evidence", usageRef), contents)
  await appendStateFile(
    store.projectRoot,
    join(store.stateRoot, "evidence", "model-usage.jsonl"),
    contents,
  )
  return { usageRef, usageHash: hash(contents) }
}

export function usageMatches(
  contents: string,
  expected: {
    runId: string
    stage: string
    inputHash: string
    policyHash: string
    usageRef: string
  },
): boolean {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
  const parsed = Receipt.safeParse(raw)
  if (!parsed.success) return false
  const receipt = parsed.data
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  return (
    receipt.runId === expected.runId &&
    receipt.stage === expected.stage &&
    receipt.inputHash === expected.inputHash &&
    receipt.outcome === "completed" &&
    receipt.transportOutcome === "output" &&
    receipt.modelCalls === 1 &&
    hash(JSON.stringify(receipt.policy)) === expected.policyHash &&
    expected.usageRef === `model-execution-${hash(`${receipt.runId}:${receipt.attemptId}`)}.json` &&
    (receipt.usage?.reportedModel == null || receipt.usage.reportedModel === receipt.policy.model)
  )
}
