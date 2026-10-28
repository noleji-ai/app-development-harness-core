import type {
  Criterion,
  ProductContext,
  ScoredCandidate,
  Scores,
  TechnologyCandidate,
  TechnologyRecommendation,
} from "../domain/technology"
import { CRITERIA } from "../domain/technology"
import { requiresUserDecision } from "./blocking-policy"

export const SCORE_WEIGHTS = {
  productExperience: 30,
  securityCompliance: 20,
  performanceIntegration: 15,
  maintainability: 15,
  ecosystem: 10,
  scheduleBudget: 5,
  reversibility: 5,
} as const

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function criterionBonus(context: ProductContext, candidate: TechnologyCandidate, key: Criterion) {
  const tags = candidate.tags
  let bonus = tags.includes(context.productKind) && key === "productExperience" ? 18 : 0
  if (context.regulated && tags.includes("regulated") && key === "securityCompliance") bonus += 15
  if (context.offlineRequired && tags.includes("offline")) {
    if (key === "productExperience") bonus += 20
    if (key === "performanceIntegration") bonus += 15
  }
  if (context.aiProcessing && tags.includes("ai")) {
    if (key === "productExperience") bonus += 25
    if (key === "maintainability") bonus += 10
  }
  if (context.budgetConstrained && tags.includes("budget") && key === "scheduleBudget") bonus += 20
  if (context.singleCodebasePriority && tags.includes("single-codebase")) {
    if (key === "productExperience") bonus += 18
    if (key === "scheduleBudget") bonus += 10
  }
  return bonus
}

function scoreCandidate(context: ProductContext, candidate: TechnologyCandidate): ScoredCandidate {
  const scores: Scores = {
    productExperience: clamp(
      candidate.baseScores.productExperience +
        criterionBonus(context, candidate, "productExperience"),
    ),
    securityCompliance: clamp(
      candidate.baseScores.securityCompliance +
        criterionBonus(context, candidate, "securityCompliance"),
    ),
    performanceIntegration: clamp(
      candidate.baseScores.performanceIntegration +
        criterionBonus(context, candidate, "performanceIntegration"),
    ),
    maintainability: clamp(
      candidate.baseScores.maintainability + criterionBonus(context, candidate, "maintainability"),
    ),
    ecosystem: clamp(
      candidate.baseScores.ecosystem + criterionBonus(context, candidate, "ecosystem"),
    ),
    scheduleBudget: clamp(
      candidate.baseScores.scheduleBudget + criterionBonus(context, candidate, "scheduleBudget"),
    ),
    reversibility: clamp(
      candidate.baseScores.reversibility + criterionBonus(context, candidate, "reversibility"),
    ),
  }
  const total = CRITERIA.reduce((sum, key) => sum + (scores[key] * SCORE_WEIGHTS[key]) / 100, 0)
  return { ...candidate, scores, total: Math.round(total * 10) / 10 }
}

export function recommendTechnology(
  context: ProductContext,
  candidates: readonly TechnologyCandidate[],
): TechnologyRecommendation {
  const scored = candidates
    .filter((candidate) => candidate.platform === context.platform)
    .map((candidate) => scoreCandidate(context, candidate))
    .sort((left, right) => right.total - left.total || left.id.localeCompare(right.id))
  const selected = scored[0]
  if (selected === undefined) {
    throw new TechnologySelectionError(context.platform)
  }
  const alternatives = scored.slice(1)
  const second = alternatives[0]
  const stackChange =
    context.existingAdapterId !== undefined && context.existingAdapterId !== selected.id
  const blocking = stackChange || (second !== undefined && requiresUserDecision(selected, second))
  const reason = stackChange
    ? "The recommendation changes the existing stack and requires explicit approval."
    : blocking
      ? "The trade-off is close, costly, or difficult to reverse."
      : "The recommendation has a reversible lead of at least ten points."
  return { selected, alternatives, blocking, reason }
}

export class TechnologySelectionError extends Error {
  readonly name = "TechnologySelectionError"
  constructor(readonly platform: string) {
    super(`no compatible technology candidates for ${platform}`)
  }
}
