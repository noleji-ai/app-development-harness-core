import { afterEach, describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { type DashboardServer, startDashboardServer } from "../../src/dashboard/server"
import type { DecisionMutation, DecisionRecord } from "../../src/domain/decision"
import { createManifest, type RunManifest } from "../../src/domain/manifest"
import { IdempotencyConflictError, RevisionConflictError } from "../../src/state/decision-ledger"

const ASSETS = resolve("assets/dashboard")

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "scope-gate",
    runId: "run-1",
    stage: "scope-approval",
    category: "product",
    blocking: true,
    status: "pending",
    recommendation: "핵심 사용자 흐름을 먼저 승인합니다.",
    alternatives: [
      { id: "focused", label: "핵심 범위", score: 92, tradeoffs: "출시 속도를 높입니다." },
      { id: "broad", label: "확장 범위", score: 74, tradeoffs: "초기 일정이 늘어납니다." },
    ],
    businessImpact: "잘못된 구현 비용을 줄입니다.",
    evidence: ["research/prd.md"],
    selected: null,
    reason: null,
    actor: "harness",
    createdAt: "2026-07-13T00:00:00.000Z",
    decidedAt: null,
    revision: 1,
    previousHash: null,
    eventHash: "a".repeat(64),
    idempotencyKey: "initial:scope-gate",
    ...overrides,
  }
}

function tokenFrom(server: DashboardServer): string {
  return new URL(server.url).hash.replace("#token=", "")
}

function auth(server: DashboardServer): Record<string, string> {
  return { authorization: `Bearer ${tokenFrom(server)}` }
}

describe("dashboard HTTP server", () => {
  const servers: DashboardServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  async function start(
    options: {
      readonly list?: () => Promise<readonly DecisionRecord[]>
      readonly mutate?: (input: DecisionMutation) => Promise<DecisionRecord>
      readonly onDecisionSaved?: (
        decision: DecisionRecord,
        input: DecisionMutation,
      ) => Promise<void>
      readonly manifest?: () => Promise<Readonly<RunManifest> | undefined>
    } = {},
  ): Promise<DashboardServer> {
    const server = await startDashboardServer({
      assetsDirectory: ASSETS,
      ledger: {
        list: options.list ?? (async () => [decision()]),
        mutate:
          options.mutate ??
          (async (input) =>
            decision({ revision: 2, status: "approved", selected: input.selected ?? null })),
      },
      ...(options.onDecisionSaved === undefined
        ? {}
        : { onDecisionSaved: options.onDecisionSaved }),
      ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
      now: () => new Date("2026-07-13T01:00:00.000Z"),
    })
    servers.push(server)
    return server
  }

  it("binds only to IPv4 loopback and puts its memory token in the URL fragment", async () => {
    // Given / When
    const server = await start()

    // Then
    expect(server.host).toBe("127.0.0.1")
    expect(tokenFrom(server)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(server.origin).not.toContain(tokenFrom(server))
  })

  it("serves external assets with strict security headers", async () => {
    // Given
    const server = await start()

    // When
    const response = await fetch(server.origin)
    const html = await response.text()

    // Then
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'")
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(html).toContain('href="/dashboard.css"')
    expect(html).toContain('src="/dashboard.js"')
    expect(html).not.toContain("<script>")
  })

  it("rejects API reads unless Host and bearer token match exactly", async () => {
    // Given
    const server = await start()

    // When
    const missing = await fetch(`${server.origin}/api/state`)
    const wrongHost = await fetch(`${server.origin}/api/state`, {
      headers: { ...auth(server), host: `localhost:${server.port}` },
    })
    const accepted = await fetch(`${server.origin}/api/state`, { headers: auth(server) })

    // Then
    expect(missing.status).toBe(401)
    expect(wrongHost.status).toBe(403)
    expect(accepted.status).toBe(200)
  })

  it("saves a decision only with the exact same-origin and expected revision", async () => {
    // Given
    let received: DecisionMutation | undefined
    const server = await start({
      mutate: async (input) => {
        received = input
        return decision({ revision: 2, status: "approved", selected: input.selected ?? null })
      },
    })
    const payload = {
      id: "scope-gate",
      runId: "run-1",
      expectedRevision: 1,
      action: "approve",
      selected: "focused",
      reason: "추천 범위가 사업 목표에 맞습니다.",
      actor: "dashboard",
      idempotencyKey: "dashboard-save-0001",
      decidedAt: "2026-07-13T01:00:00.000Z",
    }

    // When
    const rejected = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: {
        ...auth(server),
        "content-type": "application/json",
        origin: "http://127.0.0.1:1",
      },
      body: JSON.stringify(payload),
    })
    const accepted = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify(payload),
    })

    // Then
    expect(rejected.status).toBe(403)
    expect(accepted.status).toBe(200)
    expect(received?.expectedRevision).toBe(1)
  })

  it("binds legacy dashboard mutations to the active run without permitting another run", async () => {
    // Given
    let received: DecisionMutation | undefined
    const manifest = createManifest("run-active", "extend", "Build", "2026-07-13T00:00:00.000Z")
    const server = await start({
      manifest: async () => manifest,
      mutate: async (input) => {
        received = input
        return decision({ runId: input.runId, revision: 2, status: "approved" })
      },
    })
    const payload = {
      id: "scope-gate",
      expectedRevision: 1,
      action: "approve",
      selected: "focused",
      reason: "추천 범위를 승인합니다.",
      actor: "dashboard",
      idempotencyKey: "dashboard-active-run",
      decidedAt: "2026-07-13T01:00:00.000Z",
    }

    // When
    const accepted = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify(payload),
    })
    const rejected = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({
        ...payload,
        runId: "run-other",
        idempotencyKey: "dashboard-other-run",
      }),
    })

    // Then
    expect(accepted.status).toBe(200)
    expect(received?.runId).toBe(manifest.runId)
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toEqual({ error: "active_run_mismatch" })
  })

  it("links a saved decision to the execution checkpoint callback", async () => {
    // Given
    const saved: string[] = []
    const server = await start({
      onDecisionSaved: async (record, input) => {
        saved.push(`${record.stage}:${input.action}`)
      },
    })

    // When
    const response = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({
        id: "scope-gate",
        runId: "run-1",
        expectedRevision: 1,
        action: "approve",
        selected: "focused",
        reason: "추천 범위를 승인합니다.",
        actor: "dashboard",
        idempotencyKey: "dashboard-checkpoint-1",
        decidedAt: "2026-07-13T01:00:00.000Z",
      }),
    })

    // Then
    expect(response.status).toBe(200)
    expect(saved).toEqual(["scope-approval:approve"])
  })

  it("returns the current decision with 409 instead of overwriting a stale tab", async () => {
    // Given
    const current = decision({ revision: 3, status: "revision_requested" })
    const server = await start({
      list: async () => [current],
      mutate: async () => {
        throw new RevisionConflictError(1, 3)
      },
    })

    // When
    const response = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({
        id: current.id,
        runId: current.runId,
        expectedRevision: 1,
        action: "comment",
        reason: "먼저 열린 탭의 의견",
        actor: "dashboard",
        idempotencyKey: "dashboard-save-0002",
        decidedAt: "2026-07-13T01:00:00.000Z",
      }),
    })
    const body = await response.json()

    // Then
    expect(response.status).toBe(409)
    expect(body.decision.revision).toBe(3)
  })

  it("returns 409 when an idempotency key is bound to another mutation", async () => {
    // Given
    const server = await start({
      mutate: async () => {
        throw new IdempotencyConflictError("idempotency conflict")
      },
    })

    // When
    const response = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({
        id: "scope-gate",
        runId: "run-1",
        expectedRevision: 1,
        action: "comment",
        reason: "Conflicting retry.",
        actor: "dashboard",
        idempotencyKey: "dashboard-conflict-1",
        decidedAt: "2026-07-13T01:00:00.000Z",
      }),
    })

    // Then
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "idempotency_conflict" })
  })

  it("rejects JSON bodies larger than 64 KiB", async () => {
    // Given
    const server = await start()

    // When
    const response = await fetch(`${server.origin}/api/decisions`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json", origin: server.origin },
      body: JSON.stringify({ padding: "x".repeat(65 * 1024) }),
    })

    // Then
    expect(response.status).toBe(413)
  })
})
