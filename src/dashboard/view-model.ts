import type { DecisionRecord, DecisionStatus } from "../domain/decision"
import {
  PIPELINE_STAGES,
  type PipelineStage,
  type RunManifest,
  type StageState,
} from "../domain/manifest"

export type DashboardStageStatus = "complete" | "active" | "blocked" | "pending"

export interface DashboardStage {
  readonly id: PipelineStage
  readonly label: string
  readonly status: DashboardStageStatus
  readonly decisionCount: number
}

export interface DashboardDecision extends DecisionRecord {
  readonly statusLabel: string
}

export interface DashboardViewModel {
  readonly generatedAt: string
  readonly showcase: boolean
  readonly stages: readonly DashboardStage[]
  readonly decisions: readonly DashboardDecision[]
  readonly summary: {
    readonly total: number
    readonly blocking: number
    readonly decided: number
  }
}

export interface DashboardViewContext {
  readonly showcase?: boolean
  readonly manifest?: Readonly<RunManifest>
}

export class DashboardViewError extends Error {
  override readonly name = "DashboardViewError"
}

const STAGE_LABELS: Readonly<Record<PipelineStage, string>> = {
  "request-analysis": "요청 분석",
  "research-prd": "조사 · PRD",
  "scope-approval": "범위 승인",
  "design-candidates": "디자인 후보",
  "design-selection": "디자인 선택",
  "technology-optimization": "기술 최적화",
  implementation: "구현",
  verification: "테스트 · QA",
  "deploy-ready": "배포 준비",
}

function statusLabel(status: DecisionStatus): string {
  switch (status) {
    case "pending":
      return "결정 대기"
    case "approved":
      return "승인됨"
    case "rejected":
      return "반려됨"
    case "revision_requested":
      return "수정 요청"
  }
}

function decisionStageStatus(decisions: readonly DecisionRecord[]): DashboardStageStatus {
  if (decisions.length === 0) return "pending"
  if (decisions.some((item) => item.blocking && item.status !== "approved")) return "blocked"
  if (decisions.every((item) => item.status === "approved")) return "complete"
  return "active"
}

function assertNever(value: never): never {
  throw new DashboardViewError(`Unhandled stage state: ${JSON.stringify(value)}`)
}

function stageStatus(
  decisions: readonly DecisionRecord[],
  state: StageState | undefined,
): DashboardStageStatus {
  if (decisions.some((item) => item.blocking && item.status !== "approved")) return "blocked"
  if (state === undefined) return decisionStageStatus(decisions)
  switch (state.kind) {
    case "pending":
      return "pending"
    case "skipped":
      return "complete"
    case "running":
      return "active"
    case "completed":
      return "complete"
    case "blocked":
    case "failed":
    case "unverified":
      return "blocked"
    default:
      return assertNever(state)
  }
}

export function buildDashboardViewModel(
  records: readonly DecisionRecord[],
  now: Date,
  context: DashboardViewContext = {},
): DashboardViewModel {
  const activeRecords =
    context.manifest === undefined
      ? records
      : records.filter((record) => record.runId === context.manifest?.runId)
  const decisions = activeRecords.map((record) => ({
    ...record,
    statusLabel: statusLabel(record.status),
  }))
  const stages = PIPELINE_STAGES.map((stage) => {
    const stageDecisions = decisions.filter((decision) => decision.stage === stage)
    return {
      id: stage,
      label: STAGE_LABELS[stage],
      status: stageStatus(stageDecisions, context.manifest?.stages[stage]),
      decisionCount: stageDecisions.length,
    }
  })
  return {
    generatedAt: now.toISOString(),
    showcase: context.showcase ?? false,
    stages,
    decisions,
    summary: {
      total: decisions.length,
      blocking: decisions.filter((item) => item.blocking && item.status !== "approved").length,
      decided: decisions.filter((item) => item.status === "approved").length,
    },
  }
}
