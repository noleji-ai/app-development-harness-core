import { describe, expect, test } from "bun:test"
import { ADAPTERS, TECHNOLOGY_CANDIDATES } from "../../src/adapters/registry"
import { requiresUserDecision } from "../../src/decisions/blocking-policy"
import { recommendTechnology, SCORE_WEIGHTS } from "../../src/decisions/scoring"
import { SCENARIOS } from "../fixtures/technology-scenarios"

describe("technology scoring", () => {
  test("uses the approved weight total", () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(100)
  })

  test.each([
    [SCENARIOS.regulatedApi, "backend-go-postgres"],
    [SCENARIOS.aiApi, "backend-fastapi-postgres"],
    [SCENARIOS.budgetBff, "backend-nestjs-postgres"],
    [SCENARIOS.qualityWeb, "web-next"],
    [SCENARIOS.offlineWeb, "web-vite-react-pwa"],
    [SCENARIOS.ios, "ios-swiftui"],
    [SCENARIOS.android, "android-compose"],
    [SCENARIOS.macos, "macos-swiftui"],
  ])("selects %s for scenario", (scenario, expected) => {
    const result = recommendTechnology(scenario, TECHNOLOGY_CANDIDATES)
    expect(result.selected.id).toBe(expected)
  })

  test("preserves an existing stack behind explicit approval", () => {
    const result = recommendTechnology(
      { ...SCENARIOS.aiApi, existingAdapterId: "backend-nestjs-postgres" },
      TECHNOLOGY_CANDIDATES,
    )
    expect(result.blocking).toBe(true)
    expect(result.reason).toContain("existing stack")
  })

  test("auto-selects only a reversible lead of at least ten points", () => {
    const result = recommendTechnology(SCENARIOS.regulatedApi, TECHNOLOGY_CANDIDATES)
    const second = result.alternatives[0]
    expect(second).toBeDefined()
    if (second === undefined) return
    expect(requiresUserDecision(result.selected, second)).toBe(
      result.selected.total - second.total < 10,
    )
  })

  test("registers every planned v1 adapter", () => {
    expect(ADAPTERS.map((adapter) => adapter.id).sort()).toEqual(
      [
        "android-compose",
        "backend-fastapi-postgres",
        "backend-go-postgres",
        "backend-nestjs-postgres",
        "ios-swiftui",
        "macos-swiftui",
        "web-astro",
        "web-next",
        "web-vite-react-pwa",
      ].sort(),
    )
  })
})
