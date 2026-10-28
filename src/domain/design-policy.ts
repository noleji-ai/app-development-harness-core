import { z } from "zod"

export const DesignPolicyModeSchema = z.enum(["required", "delegated", "skip"])
export const DesignPolicySourceSchema = z.enum(["default", "explicit", "auto"])

export const DesignPolicySelectionSchema = z
  .object({
    mode: DesignPolicyModeSchema,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()

export const DesignPolicySchema = DesignPolicySelectionSchema.extend({
  source: DesignPolicySourceSchema,
}).strict()

export type DesignPolicySelection = z.infer<typeof DesignPolicySelectionSchema>
export type DesignPolicy = z.infer<typeof DesignPolicySchema>

export const DEFAULT_DESIGN_POLICY: DesignPolicy = {
  mode: "required",
  source: "default",
  reason: "Customer-facing applications require an explicit product design direction.",
}

const HEADLESS_ONLY =
  /\b(?:backend-only|api-only|headless|worker-only|cli-only)\b|(?:백엔드|API|헤드리스|워커|CLI)\s*전용/i
const HUMAN_DESIGN_SURFACE =
  /\b(?:customer-facing|consumer-facing|user-facing|storefront|website|dashboard|frontend|front-end|client|app|application|ios|android|macos|windows|desktop|mobile)\b|고객용|사용자용|스토어프론트|클라이언트|앱|애플리케이션|모바일|데스크톱|웹\s*(?:사이트|화면)|대시보드|프론트엔드/i
const MULTI_DELIVERABLE =
  /[,;/+]|\b(?:and|plus|with|alongside|also|including)\b|\bas\s+well\s+as\b|\btogether\s+with\b|\s(?:및|그리고|함께)\s/i

export function explicitDesignPolicy(selection: DesignPolicySelection): DesignPolicy {
  return { ...selection, source: "explicit" }
}

export function resolveDesignPolicy(
  request: string,
  requested: DesignPolicySelection | undefined,
  configured: DesignPolicy,
): DesignPolicy {
  if (requested !== undefined) return explicitDesignPolicy(requested)
  if (configured.source === "explicit") return configured
  if (HUMAN_DESIGN_SURFACE.test(request) || MULTI_DELIVERABLE.test(request)) {
    return DEFAULT_DESIGN_POLICY
  }
  if (HEADLESS_ONLY.test(request)) {
    return {
      mode: "delegated",
      source: "auto",
      reason:
        "The product request is explicitly headless; API and operations experience is delegated to the harness.",
    }
  }
  return DEFAULT_DESIGN_POLICY
}
