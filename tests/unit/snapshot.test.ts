import { describe, expect, it } from "bun:test"
import { renderDashboardSnapshot } from "../../src/dashboard/snapshot"
import { buildDashboardViewModel } from "../../src/dashboard/view-model"
import type { DecisionRecord } from "../../src/domain/decision"
import { createManifest } from "../../src/domain/manifest"

function record(value: string): DecisionRecord {
  return {
    id: "design-gate",
    runId: "run-1",
    stage: "design-selection",
    category: "design",
    blocking: true,
    status: "pending",
    recommendation: value,
    alternatives: [{ id: "calm", label: "차분한 방향", score: 91, tradeoffs: value }],
    businessImpact: value,
    evidence: [value],
    selected: null,
    reason: null,
    actor: "harness",
    createdAt: "2026-07-13T00:00:00.000Z",
    decidedAt: null,
    revision: 1,
    previousHash: null,
    eventHash: "b".repeat(64),
    idempotencyKey: "initial:design-gate",
  }
}

describe("read-only dashboard snapshot", () => {
  it("escapes ledger content and contains no executable script or token", () => {
    // Given
    const attack = '</script><script data-token="secret">globalThis.pwned=true</script>'
    const state = buildDashboardViewModel([record(attack)], new Date("2026-07-13T01:00:00.000Z"))

    // When
    const html = renderDashboardSnapshot(state)

    // Then
    expect(html).not.toContain(attack)
    expect(html).not.toContain("<script")
    expect(html).not.toContain('data-token="secret"')
    expect(html).not.toContain("#token=")
    expect(html).toContain("&lt;/script&gt;")
    expect(html).toContain("<main")
    expect(html).toContain("읽기 전용 스냅샷")
  })

  it("summarizes blocking decisions and preserves Korean text", () => {
    // Given
    const state = buildDashboardViewModel(
      [record("개인정보 보관 기간을 먼저 확정합니다.")],
      new Date(),
    )

    // When
    const html = renderDashboardSnapshot(state)

    // Then
    expect(state.summary.blocking).toBe(1)
    expect(html).toContain("개인정보 보관 기간을 먼저 확정합니다.")
    expect(html).toContain("차단 결정 1개")
  })

  it("derives progress from the run manifest when a stage has no decision", () => {
    // Given
    const manifest = createManifest("run-dashboard", "create", "Build", "2026-07-13T00:00:00.000Z")
    manifest.stages["request-analysis"] = {
      kind: "completed",
      inputHash: "request",
      outputHash: "request",
      evidenceIds: ["state:request-analysis"],
      completedAt: "2026-07-13T00:00:00.000Z",
    }

    // When
    const state = buildDashboardViewModel([], new Date(), { manifest })

    // Then
    expect(state.stages.find((stage) => stage.id === "request-analysis")?.status).toBe("complete")
  })

  it("shows only the active run and treats an explicit design skip as complete", () => {
    // Given
    const manifest = createManifest(
      "run-dashboard",
      "create",
      "Build a backend service with no user interface",
      "2026-07-13T00:00:00.000Z",
      {
        mode: "skip",
        source: "explicit",
        reason: "This service has no user-facing surface.",
      },
    )
    manifest.stages["design-candidates"] = { kind: "skipped", reason: manifest.designPolicy.reason }
    const current = { ...record("현재 실행의 범위 결정"), runId: manifest.runId }

    // When
    const state = buildDashboardViewModel(
      [record("이전 실행의 승인"), current],
      new Date("2026-07-13T01:00:00.000Z"),
      { manifest },
    )

    // Then
    expect(state.decisions.map((decision) => decision.businessImpact)).toEqual([
      "현재 실행의 범위 결정",
    ])
    expect(state.summary.total).toBe(1)
    expect(state.stages.find((stage) => stage.id === "design-candidates")?.status).toBe("complete")
  })
})
