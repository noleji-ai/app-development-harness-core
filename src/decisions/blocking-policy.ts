import type { ScoredCandidate } from "../domain/technology"

export function requiresUserDecision(first: ScoredCandidate, second: ScoredCandidate): boolean {
  if (!first.reversible || first.highExternalCost) return true
  return first.total - second.total < 10
}
