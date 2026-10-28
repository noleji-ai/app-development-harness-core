import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { ZodError } from "zod"
import {
  type DecisionMutation,
  DecisionMutationSchema,
  type DecisionRecord,
} from "../domain/decision"
import type { RunManifest } from "../domain/manifest"
import { IdempotencyConflictError, RevisionConflictError } from "../state/decision-ledger"
import {
  assertApiRequest,
  assertLocalRequest,
  createDashboardToken,
  DASHBOARD_HOST,
  DashboardRequestError,
  dashboardSecurityHeaders,
  MAX_JSON_BYTES,
} from "./security"
import { buildDashboardViewModel } from "./view-model"

export interface DashboardLedgerCallbacks {
  list(): Promise<readonly DecisionRecord[]>
  mutate(input: DecisionMutation): Promise<DecisionRecord>
}

export interface DashboardServerOptions {
  readonly assetsDirectory: string
  readonly ledger: DashboardLedgerCallbacks
  readonly manifest?: () => Promise<Readonly<RunManifest> | undefined>
  readonly onDecisionSaved?: (decision: DecisionRecord, input: DecisionMutation) => Promise<void>
  readonly port?: number
  readonly now?: () => Date
}

export interface DashboardServer {
  readonly host: typeof DASHBOARD_HOST
  readonly port: number
  readonly origin: string
  readonly url: string
  close(): Promise<void>
}

const ASSETS: Readonly<Record<string, readonly [string, string]>> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/dashboard.css": ["dashboard.css", "text/css; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  contentType: string,
): void {
  response.writeHead(status, { ...dashboardSecurityHeaders(), "content-type": contentType })
  response.end(body)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028|\u2029/g, "")
  send(response, status, body, "application/json; charset=utf-8")
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new DashboardRequestError(413, "body_too_large")
  }
  let size = 0
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_JSON_BYTES) throw new DashboardRequestError(413, "body_too_large")
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

async function readDecisionMutation(
  request: IncomingMessage,
  options: DashboardServerOptions,
): Promise<DecisionMutation> {
  const body = await readJson(request)
  const manifest = await options.manifest?.()
  const candidate =
    manifest !== undefined && typeof body === "object" && body !== null && !Array.isArray(body)
      ? { runId: manifest.runId, ...body }
      : body
  const input = DecisionMutationSchema.parse(candidate)
  if (manifest !== undefined && input.runId !== manifest.runId) {
    throw new DashboardRequestError(409, "active_run_mismatch")
  }
  return input
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
  token: string,
  options: DashboardServerOptions,
): Promise<boolean> {
  if (url.pathname === "/api/state" && request.method === "GET") {
    assertApiRequest(request, origin, token, false)
    const records = await options.ledger.list()
    const now = options.now?.() ?? new Date()
    const manifest = await options.manifest?.()
    sendJson(
      response,
      200,
      buildDashboardViewModel(records, now, {
        showcase: url.searchParams.get("showcase") === "1",
        ...(manifest === undefined ? {} : { manifest }),
      }),
    )
    return true
  }
  if (url.pathname === "/api/decisions" && request.method === "POST") {
    assertApiRequest(request, origin, token, true)
    if (request.headers["content-type"] !== "application/json") {
      throw new DashboardRequestError(415, "content_type_must_be_json")
    }
    const input = await readDecisionMutation(request, options)
    try {
      const decision = await options.ledger.mutate(input)
      await options.onDecisionSaved?.(decision, input)
      sendJson(response, 200, { decision })
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        const current = (await options.ledger.list()).find(
          (item) => item.id === input.id && item.runId === input.runId,
        )
        sendJson(response, 409, { error: "idempotency_conflict", decision: current ?? null })
        return true
      }
      if (!(error instanceof RevisionConflictError)) throw error
      const current = (await options.ledger.list()).find(
        (item) => item.id === input.id && item.runId === input.runId,
      )
      sendJson(response, 409, { error: "revision_conflict", decision: current ?? null })
    }
    return true
  }
  return false
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  token: string,
  options: DashboardServerOptions,
): Promise<void> {
  try {
    assertLocalRequest(request, origin)
    const url = new URL(request.url ?? "/", origin)
    if (await handleApi(request, response, url, origin, token, options)) return
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" })
      return
    }
    const asset = ASSETS[url.pathname]
    if (asset === undefined) {
      sendJson(response, 404, { error: "not_found" })
      return
    }
    const [file, contentType] = asset
    send(response, 200, await readFile(join(options.assetsDirectory, file)), contentType)
  } catch (error) {
    if (error instanceof DashboardRequestError) {
      sendJson(response, error.status, { error: error.code })
      return
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      sendJson(response, 400, { error: "invalid_json" })
      return
    }
    sendJson(response, 500, { error: "internal_error" })
  }
}

export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const token = createDashboardToken()
  let origin = ""
  const server = createServer((request, response) => {
    void route(request, response, origin, token, options)
  })
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, DASHBOARD_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new DashboardRequestError(500, "invalid_server_address"))
        return
      }
      resolvePort(address.port)
    })
  })
  origin = `http://${DASHBOARD_HOST}:${port}`
  return {
    host: DASHBOARD_HOST,
    port,
    origin,
    url: `${origin}/#token=${token}`,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)))
      }),
  }
}
