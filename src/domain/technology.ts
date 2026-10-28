export const CRITERIA = [
  "productExperience",
  "securityCompliance",
  "performanceIntegration",
  "maintainability",
  "ecosystem",
  "scheduleBudget",
  "reversibility",
] as const

export type Criterion = (typeof CRITERIA)[number]

export type Scores = Readonly<Record<Criterion, number>>

export const PlatformSchema = z.enum(["web", "backend", "ios", "android", "macos"])

export type Platform = z.infer<typeof PlatformSchema>

export type ProductContext = {
  readonly platform: Platform
  readonly productKind: "interactive" | "content" | "pwa" | "api" | "ai-data" | "bff" | "desktop"
  readonly regulated: boolean
  readonly offlineRequired: boolean
  readonly aiProcessing: boolean
  readonly budgetConstrained: boolean
  readonly singleCodebasePriority: boolean
  readonly existingAdapterId?: string
}

export type TechnologyCandidate = {
  readonly id: string
  readonly label: string
  readonly platform: Platform
  readonly baseScores: Scores
  readonly tags: readonly string[]
  readonly reversible: boolean
  readonly highExternalCost: boolean
  readonly capabilities: readonly string[]
}

export type ScoredCandidate = TechnologyCandidate & {
  readonly scores: Scores
  readonly total: number
}

export type TechnologyRecommendation = {
  readonly selected: ScoredCandidate
  readonly alternatives: readonly ScoredCandidate[]
  readonly blocking: boolean
  readonly reason: string
}

import { z } from "zod"
