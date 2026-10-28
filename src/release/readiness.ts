import { z } from "zod"

export type CheckStatus = "passed" | "failed" | "blocked" | "unverified" | "waived"

export const REQUIRED_RELEASE_CHECK_IDS = [
  "build",
  "test",
  "manual-qa",
  "security",
  "release-bundle",
] as const

export const VerificationCheckSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    required: z.boolean(),
    status: z.enum(["passed", "failed", "blocked", "unverified", "waived"]),
    evidenceIds: z.array(z.string().trim().min(1).max(512)),
  })
  .strict()

export interface VerificationCheck {
  readonly id: string
  readonly required: boolean
  readonly status: CheckStatus
  readonly evidenceIds: readonly string[]
}

export interface ReadinessBlocker {
  readonly checkId: string
  readonly reason: Exclude<CheckStatus, "passed"> | "missing-evidence" | "missing-check"
}

export interface ReadinessAssessment {
  readonly ready: boolean
  readonly blockers: readonly ReadinessBlocker[]
  readonly passedEvidenceIds: readonly string[]
}

export class ReadinessInputError extends Error {
  override readonly name = "ReadinessInputError"
}

function parseChecks(rawChecks: unknown): readonly VerificationCheck[] {
  const checks = z.array(VerificationCheckSchema).parse(rawChecks)
  const seen = new Set<string>()
  for (const check of checks) {
    if (seen.has(check.id)) throw new ReadinessInputError(`duplicate readiness check: ${check.id}`)
    seen.add(check.id)
  }
  return checks
}

export function assessReadiness(
  rawChecks: unknown,
  rawRequiredCheckIds?: unknown,
): ReadinessAssessment {
  const checks = parseChecks(rawChecks)
  const requiredCheckIds =
    rawRequiredCheckIds === undefined
      ? checks.filter((check) => check.required).map((check) => check.id)
      : z.array(z.string().trim().min(1).max(128)).parse(rawRequiredCheckIds)
  const byId = new Map(checks.map((check) => [check.id, check]))
  const blockers: ReadinessBlocker[] = []
  const passedEvidenceIds: string[] = []

  for (const id of new Set(requiredCheckIds)) {
    const check = byId.get(id)
    if (!check || !check.required) {
      blockers.push({ checkId: id, reason: "missing-check" })
    } else if (check.status !== "passed") {
      blockers.push({ checkId: id, reason: check.status })
    } else if (check.evidenceIds.length === 0) {
      blockers.push({ checkId: id, reason: "missing-evidence" })
    } else {
      passedEvidenceIds.push(...check.evidenceIds)
    }
  }

  return { ready: blockers.length === 0, blockers, passedEvidenceIds }
}
