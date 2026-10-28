import { z } from "zod"
import type { CodexOwnedStage } from "./codex-stage-prompt"

export const ImplementationTierSchema = z.enum(["standard", "complex"])
export const MAX_CAPTURE_BYTES = 1024 * 1024
export const ModelPolicySchema = z
  .object({
    version: z.literal("quality-cost-v1"),
    maxWorkers: z.literal(2),
    profile: z.enum(["app-dev", "app-dev-plan"]),
    model: z.enum(["gpt-5.6-sol", "gpt-5.6-terra"]),
    effort: z.enum(["medium", "high"]),
  })
  .strict()

export interface ModelPolicy {
  readonly version: "quality-cost-v1"
  readonly profile: "app-dev" | "app-dev-plan"
  readonly model: "gpt-5.6-sol" | "gpt-5.6-terra"
  readonly effort: "medium" | "high"
  readonly maxWorkers: 2
}

export function resolveModelPolicy(
  stage: CodexOwnedStage,
  tier: "standard" | "complex" = "standard",
): ModelPolicy {
  const base = { version: "quality-cost-v1", maxWorkers: 2 } as const
  switch (stage) {
    case "request-analysis":
      return { ...base, profile: "app-dev-plan", model: "gpt-5.6-sol", effort: "medium" }
    case "research-prd":
    case "design-candidates":
    case "technology-optimization":
      return { ...base, profile: "app-dev-plan", model: "gpt-5.6-sol", effort: "high" }
    case "implementation":
      return {
        ...base,
        profile: "app-dev",
        model: tier === "complex" ? "gpt-5.6-sol" : "gpt-5.6-terra",
        effort: "medium",
      }
    case "verification":
    case "deploy-ready":
      return { ...base, profile: "app-dev", model: "gpt-5.6-sol", effort: "high" }
    default: {
      const unreachable: never = stage
      return unreachable
    }
  }
}

export function modelConfig(policy: ModelPolicy): Record<string, string | number> {
  return {
    model_reasoning_effort: policy.effort,
    "agents.max_threads": policy.maxWorkers,
    model_auto_compact_token_limit: 180000,
    service_tier: "default",
  }
}
