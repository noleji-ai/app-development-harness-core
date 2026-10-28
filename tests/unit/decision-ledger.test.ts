import { describe, expect, test } from "bun:test"
import { DecisionInputSchema, DecisionMutationSchema } from "../../src/domain/decision"

describe("decision boundaries", () => {
  test("rejects unknown fields and oversized comments", () => {
    expect(
      DecisionMutationSchema.safeParse({
        id: "gate-1",
        expectedRevision: 1,
        action: "comment",
        reason: "x".repeat(4001),
        actor: "user",
        idempotencyKey: "comment-1",
        decidedAt: "2026-07-13T00:00:00.000Z",
        injected: true,
      }).success,
    ).toBe(false)
  })

  test("limits alternatives at the boundary", () => {
    const result = DecisionInputSchema.safeParse({
      id: "gate-1",
      runId: "run-1",
      stage: "scope-approval",
      category: "scope",
      blocking: true,
      recommendation: "Focused scope",
      alternatives: Array.from({ length: 21 }, (_, index) => ({
        id: `option-${index}`,
        label: "Option",
        score: 50,
        tradeoffs: "Trade-off",
      })),
      businessImpact: "Impact",
      evidence: [],
      actor: "harness",
      createdAt: "2026-07-13T00:00:00.000Z",
    })
    expect(result.success).toBe(false)
  })
})
